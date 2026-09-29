import { describe, test, expect } from "bun:test";
import { TurboMigrator } from "../src/shim/turbo_migrator";
import { NxMigrator } from "../src/shim/nx_migrator";
import { LernaMigrator } from "../src/shim/lerna_migrator";
import { NpmMigrator } from "../src/shim/npm_migrator";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("Zero-Config Migrators", () => {
    test("TurboMigrator - parses turbo.json statically", async () => {
        const tmp = path.join(os.tmpdir(), `turbo-${Date.now()}.json`);
        await fs.writeFile(tmp, JSON.stringify({
            pipeline: {
                build: { dependsOn: ["^build"], outputs: ["dist/**"] },
                test: { dependsOn: ["build"], inputs: ["src/**"] }
            }
        }));
        
        const tasks = TurboMigrator.migrate(tmp);
        expect(tasks.length).toBe(2);
        
        const build = tasks.find(t => t.id === "build");
        expect(build?.deps).toEqual(["build"]); // ^build becomes build
        expect(build?.writes).toEqual(["dist/**"]);
        
        const testT = tasks.find(t => t.id === "test");
        expect(testT?.deps).toEqual(["build"]);
        expect(testT?.reads).toEqual(["src/**"]);
        
        await fs.unlink(tmp).catch(()=>{});
    });

    test("TurboMigrator - rejects ACE in .js files", () => {
        expect(() => TurboMigrator.migrate("turbo.js")).toThrow("Only static .json");
    });

    test("NxMigrator - parses nx.json statically", async () => {
        const tmp = path.join(os.tmpdir(), `nx-${Date.now()}.json`);
        await fs.writeFile(tmp, JSON.stringify({
            targetDefaults: {
                build: { dependsOn: ["^build"], outputs: ["{workspaceRoot}/dist"] }
            }
        }));
        
        const tasks = NxMigrator.migrate(tmp);
        expect(tasks.length).toBe(1);
        expect(tasks[0].id).toBe("build");
        expect(tasks[0].cmd).toEqual(["npx", "nx", "run", "build"]);
        expect(tasks[0].deps).toEqual(["build"]);
        expect(tasks[0].writes).toEqual(["{workspaceRoot}/dist"]);
        
        await fs.unlink(tmp).catch(()=>{});
    });

    test("LernaMigrator - generates standard build/test", async () => {
        const tmp = path.join(os.tmpdir(), `lerna-${Date.now()}.json`);
        await fs.writeFile(tmp, JSON.stringify({ version: "1.0.0" }));
        
        const tasks = LernaMigrator.migrate(tmp);
        expect(tasks.length).toBe(2);
        expect(tasks[0].id).toBe("build");
        expect(tasks[0].cmd).toEqual(["npx", "lerna", "run", "build"]);
        
        await fs.unlink(tmp).catch(()=>{});
    });

    test("NpmMigrator - parses package.json scripts", async () => {
        const tmp = path.join(os.tmpdir(), `package-${Date.now()}.json`);
        await fs.writeFile(tmp, JSON.stringify({
            scripts: { lint: "eslint", test: "jest" }
        }));
        
        const tasks = NpmMigrator.migrate(tmp);
        expect(tasks.length).toBe(2);

        const lint = tasks.find(t => t.id === "lint");
        expect(lint?.cmd.slice(0, 3)).toEqual(["npm", "run", "lint"]);
        // --prefix pins the script to the package's own directory, because
        // B4mal executes tasks with cwd set to the project root.
        expect(lint?.cmd.slice(3)).toEqual(["--prefix", path.dirname(tmp)]);

        await fs.unlink(tmp).catch(()=>{});
    });
});

// ─── Nx `dependsOn` object form ──────────────────────────────────────────────
//
// Nx accepts both `"^build"` strings and `{ target, projects }` objects. Only the
// string form was handled, so a workspace using objects threw
// `TypeError: d.replace is not a function` inside the map. The wizard catches
// migration errors and falls back to AST discovery, which emits one placeholder
// task per source file — TanStack/query produced 565 of them from one object and
// an entire repository's lock was worthless.

describe("NxMigrator — dependsOn shapes", () => {
    /** Write an nx.json fixture and migrate it. */
    async function migrateNx(targetDefaults: unknown): Promise<any[]> {
        const tmp = path.join(os.tmpdir(), `nx-shapes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        await fs.writeFile(tmp, JSON.stringify({ targetDefaults }));
        try {
            return NxMigrator.migrate(tmp);
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    }

    test("handles the object form, taking the target name", async () => {
        const tasks = await migrateNx({
            "test:knip": { dependsOn: [{ target: "build", projects: ["directory:packages/*"] }] },
        });

        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe("test:knip");
        expect(tasks[0].deps).toEqual(["build"]);
    });

    test("handles mixed string and object entries", async () => {
        const tasks = await migrateNx({
            build: { dependsOn: ["^build"] },
            test: { dependsOn: ["^build", { target: "lint" }, "^typecheck"] },
        });

        expect(tasks).toHaveLength(2);
        expect(tasks[1].deps).toEqual(["build", "lint", "typecheck"]);
    });

    test("does not throw on malformed entries", async () => {
        // A single bad entry must not fail the migration; it is skipped.
        const tasks = await migrateNx({
            build: { dependsOn: [42, null, {}, { target: 7 }, "  ", "^real"] },
        });

        expect(tasks).toHaveLength(1);
        expect(tasks[0].deps).toEqual(["real"]);
    });

    test("deduplicates while preserving order", async () => {
        const tasks = await migrateNx({
            test: { dependsOn: ["^build", { target: "build" }, "lint", "^build"] },
        });

        expect(tasks[0].deps).toEqual(["build", "lint"]);
    });

    test("is a no-op for tasks without dependsOn", async () => {
        const tasks = await migrateNx({ format: { inputs: ["{projectRoot}/**"] } });

        expect(tasks[0].deps).toEqual([]);
        expect(tasks[0].reads).toEqual(["{projectRoot}/**"]);
    });

    test("survives a real-world nx.json carrying both shapes", async () => {
        // Shape taken from TanStack/query, which is what surfaced this.
        const tasks = await migrateNx({
            build: { dependsOn: ["^build"], outputs: ["{projectRoot}/dist/**"] },
            "test:knip": { dependsOn: [{ target: "build", projects: ["directory:packages/*"] }] },
            "test:lib": { dependsOn: ["^build"] },
        });

        expect(tasks.map(t => t.id)).toEqual(["build", "test:knip", "test:lib"]);
        expect(tasks.every(t => typeof t.id === "string")).toBe(true);
        expect(tasks[1].deps).toEqual(["build"]);
    });
});

describe("TurboMigrator — dependsOn robustness", () => {
    test("does not throw on a non-string dependsOn entry", async () => {
        const tmp = path.join(os.tmpdir(), `turbo-shapes-${Date.now()}.json`);
        await fs.writeFile(tmp, JSON.stringify({
            tasks: { build: { dependsOn: [{ target: "prepare" }, "^compile", 7] } },
        }));

        const tasks = TurboMigrator.migrate(tmp);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].deps).toEqual(["prepare", "compile"]);

        await fs.unlink(tmp).catch(() => {});
    });
});
