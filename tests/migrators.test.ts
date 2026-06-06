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
        expect(tasks.find(t => t.id === "lint")?.cmd).toEqual(["npm", "run", "lint"]);
        
        await fs.unlink(tmp).catch(()=>{});
    });
});
