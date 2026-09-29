/**
 * Tests: `b4mal init` against a workspace whose nx.json uses the object form of
 * `dependsOn`.
 *
 * This is the end-to-end shape of a real failure. TanStack/query's nx.json
 * contains `{ "target": "build", "projects": ["directory:packages/*"] }`, which
 * crashed NxMigrator with `TypeError: d.replace is not a function`. The wizard
 * swallows migration errors and falls back to AST discovery, so the user got:
 *
 *     Migration failed: d.replace is not a function. Falling back to AST discovery.
 *     [OK] b4mal.lock generated — 565 task(s).
 *
 * Every one of those 565 tasks was an `echo` placeholder, i.e. a lockfile that
 * looked substantial and could not build anything. The unit tests cover the
 * migrator; these cover the user-visible outcome.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "../src/cli/index.ts");

let dir: string | undefined;

afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
});

/** Project with an nx.json, a package.json and some source files. */
function makeNxProject(nxJson: unknown): string {
    dir = mkdtempSync(join(tmpdir(), "b4mal-init-nx-"));

    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "nx build" } }, null, 2));
    writeFileSync(join(dir, "nx.json"), JSON.stringify(nxJson, null, 2));

    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, "src", `mod${i}.ts`), `export const v${i} = ${i};\n`);
    }

    return dir;
}

async function init(cwd: string) {
    const proc = Bun.spawn(["bun", CLI, "init"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore", // non-interactive, as in CI
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode, output: stdout + stderr };
}

function lockTasks(cwd: string): any[] {
    const raw = JSON.parse(readFileSync(join(cwd, "b4mal.lock"), "utf-8"));
    return Array.isArray(raw) ? raw : raw.tasks ?? [];
}

const REAL_WORLD_NX = {
    targetDefaults: {
        build: { dependsOn: ["^build"], outputs: ["{projectRoot}/dist/**"] },
        "test:knip": { dependsOn: [{ target: "build", projects: ["directory:packages/*"] }] },
        "test:lib": { dependsOn: ["^build"] },
    },
};

describe("b4mal init — nx.json with object-form dependsOn", () => {
    test("does not fall back to AST discovery", async () => {
        const cwd = makeNxProject(REAL_WORLD_NX);
        const result = await init(cwd);

        expect(result.exitCode).toBe(0);
        expect(result.output).not.toMatch(/Migration failed/);
        expect(result.output).not.toMatch(/Falling back to AST discovery/);
    });

    test("produces a lockfile with no placeholder commands", async () => {
        const cwd = makeNxProject(REAL_WORLD_NX);
        await init(cwd);

        expect(existsSync(join(cwd, "b4mal.lock"))).toBe(true);

        const tasks = lockTasks(cwd);
        expect(tasks.length).toBeGreaterThan(0);

        const placeholders = tasks.filter(t => (t.cmd ?? [])[0] === "echo");
        expect(placeholders).toEqual([]);

        // Not the hundreds of AST-discovered stubs the fallback produced.
        expect(tasks.length).toBeLessThan(50);
    });

    test("resolves the object entry to its target as a dependency", async () => {
        const cwd = makeNxProject(REAL_WORLD_NX);
        await init(cwd);

        const knip = lockTasks(cwd).find(t => t.id === "test:knip");
        expect(knip).toBeDefined();
        expect(knip.deps).toEqual(["build"]);
        expect(knip.cmd).toEqual(["npx", "nx", "run", "test:knip"]);
    });

    test("reports real commands rather than warning about placeholders", async () => {
        const cwd = makeNxProject(REAL_WORLD_NX);
        const result = await init(cwd);

        expect(result.output).toMatch(/all with real commands/);
        expect(result.output).not.toMatch(/placeholder commands/);
    });

    test("a string-only nx.json still migrates", async () => {
        const cwd = makeNxProject({
            targetDefaults: { build: { dependsOn: ["^build"] }, lint: { dependsOn: [] } },
        });
        const result = await init(cwd);

        expect(result.output).not.toMatch(/Migration failed/);
        const tasks = lockTasks(cwd);
        expect(tasks.map(t => t.id).sort()).toEqual(["build", "lint"]);
    });
});
