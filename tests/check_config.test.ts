/**
 * Tests: `check` sees the config, and stdout stays machine-readable.
 *
 * Two defects, both found by feeding the CLI malformed and unusual input rather
 * than well-formed fixtures.
 *
 * 1. `check` read only the lockfile. The README's quick start tells a user to
 *    write b4mal.config.json and then run `b4mal check` before `build`, and that
 *    sequence failed with "No b4mal.lock found. Run 'b4mal init' first" — even
 *    though `build` compiles the lock from the config on its own. A verifier that
 *    cannot see the file the user edited is not verifying what they think.
 *
 * 2. Adding that sync introduced a bug: the progress line went to stdout, so
 *    `check --json` emitted "Loading b4mal.config.json..." ahead of its payload
 *    and no longer parsed. Progress belongs on stderr; stdout belongs to output.
 *
 * The lockfile is also validated now — it is the artifact that actually gets
 * executed and it had no validation at all.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "../src/cli/index.ts");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4mal-checkcfg-"));
});

afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]) {
    const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode, combined: stdout + stderr };
}

const CONFIG = JSON.stringify({
    tasks: {
        gen: { cmd: ["echo", "gen"], outputs: ["out/a.txt"] },
        use: { cmd: ["echo", "use"], inputs: ["out/a.txt"], dependencies: ["gen"] },
    },
}, null, 2);

// ─── The documented workflow: config, then check ────────────────────────────

describe("check — reads the config, not just the lockfile", () => {
    test("verifies a config-only project without requiring init first", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), CONFIG);
        expect(existsSync(join(dir, "b4mal.lock"))).toBe(false);

        const r = await cli(["check"]);

        expect(r.exitCode).toBe(0);
        expect(r.combined).toMatch(/verified/i);
        expect(r.combined).not.toMatch(/No b4mal\.lock found/);
    });

    test("compiles the lockfile as a side effect, as build does", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), CONFIG);
        await cli(["check"]);

        expect(existsSync(join(dir, "b4mal.lock"))).toBe(true);
        const lock = JSON.parse(readFileSync(join(dir, "b4mal.lock"), "utf-8"));
        const tasks = Array.isArray(lock) ? lock : lock.tasks;
        expect(tasks.map((t: any) => t.id).sort()).toEqual(["gen", "use"]);
    });

    test("reports a collision introduced in the config, without init", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), JSON.stringify({
            tasks: {
                alpha: { cmd: ["echo", "a"], outputs: ["out/shared.txt"] },
                beta: { cmd: ["echo", "b"], outputs: ["out/shared.txt"] },
            },
        }));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/out\/shared\.txt/);
    });
});

// ─── The --json contract ────────────────────────────────────────────────────

describe("check --json — stdout is only the payload", () => {
    test("parses when a config sync has to happen", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), CONFIG);

        const r = await cli(["check", "--json"]);

        expect(r.exitCode).toBe(0);
        // The whole point: this must not throw.
        const parsed = JSON.parse(r.stdout);
        expect(parsed.verified).toBe(true);
        // ...and the progress line still has to reach the user.
        expect(r.stderr).toMatch(/Loading b4mal\.config\.json/);
    });

    test("parses when the lockfile is already fresh", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), CONFIG);
        await cli(["check"]);                       // warm the lockfile

        const r = await cli(["check", "--json"]);
        expect(() => JSON.parse(r.stdout)).not.toThrow();
    });

    test("parses on failure too, and reports the finding", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), JSON.stringify({
            tasks: {
                alpha: { cmd: ["echo", "a"], outputs: ["out/shared.txt"] },
                beta: { cmd: ["echo", "b"], outputs: ["out/shared.txt"] },
            },
        }));

        const r = await cli(["check", "--json"]);
        expect(r.exitCode).toBe(1);

        const parsed = JSON.parse(r.stdout);
        expect(parsed.verified).toBe(false);
        expect(parsed.shadows).toBe(1);
    });
});

// ─── Lockfile validation ────────────────────────────────────────────────────

describe("lockfile validation", () => {
    const writeLock = (lock: string) => writeFileSync(join(dir, "b4mal.lock"), lock);

    test("rejects a task with no id", async () => {
        writeLock(JSON.stringify([{ cmd: ["echo", "hi"] }]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/has no "id"/);
    });

    test("rejects a cmd that is not an array", async () => {
        // "echo hi" read as an array would otherwise execute as the command "e".
        writeLock(JSON.stringify([{ id: "a", cmd: "echo hi" }]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/non-empty "cmd" array/);
    });

    test("rejects an empty cmd array", async () => {
        writeLock(JSON.stringify([{ id: "a", cmd: [] }]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/non-empty "cmd" array/);
    });

    test("rejects a cmd array containing a non-string", async () => {
        writeLock(JSON.stringify([{ id: "a", cmd: ["echo", 42] }]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/non-empty "cmd" array/);
    });

    test("rejects malformed JSON with the filename in the message", async () => {
        writeLock("{ not json");
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/Failed to parse b4mal\.lock/);
    });

    test("names the lockfile, not just the parse error", async () => {
        // A project has both a config and a lockfile; "JSON Parse error:
        // Expected '}'" alone does not say which one is broken.
        writeFileSync(join(dir, "b4mal.config.json"), CONFIG);
        writeLock("{ not json");
        const r = await cli(["check"]);
        expect(r.combined).toMatch(/b4mal\.lock/);
    });

    test("accepts a well-formed lockfile", async () => {
        writeLock(JSON.stringify([{ id: "a", cmd: ["echo", "hi"] }]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(0);
        expect(r.combined).toMatch(/verified/i);
    });

    test("reports a cycle in the lockfile rather than hanging", async () => {
        writeLock(JSON.stringify([
            { id: "a", cmd: ["echo"], deps: ["b"] },
            { id: "b", cmd: ["echo"], deps: ["a"] },
        ]));
        const r = await cli(["check"]);
        expect(r.exitCode).toBe(1);
        expect(r.combined).toMatch(/Cycle detected/i);
    });
});

// ─── An empty lockfile is not a verification ────────────────────────────────

describe("check — empty lockfile", () => {
    test("says nothing was verified instead of reporting success", async () => {
        // An empty DAG verifies vacuously. Reporting "DAG verified" for a lock
        // that contains no tasks hides the case where generation went wrong.
        writeFileSync(join(dir, "b4mal.lock"), "[]");

        const r = await cli(["check"]);

        expect(r.exitCode).toBe(0);
        expect(r.combined).toMatch(/no tasks/i);
        expect(r.combined).not.toMatch(/DAG verified/);
    });

    test("marks it in --json so tooling can tell the difference", async () => {
        writeFileSync(join(dir, "b4mal.lock"), "[]");

        const r = await cli(["check", "--json"]);
        const parsed = JSON.parse(r.stdout);

        expect(parsed.taskCount).toBe(0);
        expect(parsed.note).toMatch(/nothing was verified/i);
    });

    test("a populated lockfile still reports a normal task count", async () => {
        writeFileSync(join(dir, "b4mal.lock"),
            JSON.stringify([{ id: "a", cmd: ["echo", "hi"] }]));

        const json = await cli(["check", "--json"]);
        const parsed = JSON.parse(json.stdout);

        expect(parsed.taskCount).toBe(1);
        expect(parsed.note).toBeUndefined();

        // Asserted in a separate run: --json replaces the human-readable output
        // rather than accompanying it, so the two cannot share one invocation.
        const human = await cli(["check"]);
        expect(human.combined).toMatch(/DAG verified/);
    });
});
