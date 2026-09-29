/**
 * Tests: `b4mal check` end-to-end.
 *
 * The audit used to miss the most obvious shadowing case. Two tasks declaring
 * the same output with no dependency between them produced:
 *
 *     [OK] DAG verified — no collisions, no shadowing.
 *
 * The WavePlanner serialized the pair with a synthetic edge, which kept
 * `plan.conflicts` empty, and the shadow audit only compared tasks against
 * their *declared* transitive dependencies — so the overlap was invisible to
 * both halves of `check`. The result contradicted `detectShadowing`'s own
 * docstring ("deterministic overwrites") and exited 0.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CLI_PATH = join(import.meta.dir, "../src/cli/index.ts");

interface CLIResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function runCLI(args: string[], cwd: string): Promise<CLIResult> {
    const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, B4MAL_DB_PATH: join(cwd, "test_cache.db") },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
}

/** Materialise a project with the given config and compile its lockfile. */
async function fixture(name: string, config: unknown): Promise<string> {
    const dir = join(tmpdir(), `b4mal-check-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "b4mal.config.json"), JSON.stringify(config, null, 2));

    // --sync compiles the lock; --dry-run stops before executing anything.
    const sync = await runCLI(["build", "--sync", "--dry-run"], dir);
    if (sync.exitCode !== 0) {
        throw new Error(`fixture setup failed for ${name}: ${sync.stdout}${sync.stderr}`);
    }
    return dir;
}

const dirs: string[] = [];

afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ─── The regression ─────────────────────────────────────────────────────────

describe("b4mal check — independent tasks declaring the same output", () => {
    let dir: string;

    beforeAll(async () => {
        dir = await fixture("shared-output", {
            tasks: {
                alpha: { cmd: ["sh", "-c", "echo alpha > out/shared.txt"], outputs: ["out/shared.txt"] },
                beta: { cmd: ["sh", "-c", "echo beta  > out/shared.txt"], outputs: ["out/shared.txt"] },
            },
        });
        dirs.push(dir);
    });

    test("lockfile really has no dependency between the two tasks", async () => {
        const lock = JSON.parse(await fs.readFile(join(dir, "b4mal.lock"), "utf-8"));
        const tasks = Array.isArray(lock) ? lock : lock.tasks;
        for (const t of tasks) {
            expect(t.dependencies ?? t.deps ?? []).toEqual([]);
        }
    });

    test("exits non-zero instead of reporting a clean DAG", async () => {
        const result = await runCLI(["check"], dir);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toMatch(/no collisions, no shadowing/);
    });

    test("names both tasks and the contested path", async () => {
        const result = await runCLI(["check"], dir);
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/alpha/);
        expect(output).toMatch(/beta/);
        expect(output).toMatch(/out\/shared\.txt/);
    });

    test("--json reports the shadow", async () => {
        const result = await runCLI(["check", "--json"], dir);
        expect(result.exitCode).toBe(1);

        const report = JSON.parse(result.stdout);
        expect(report.verified).toBe(false);
        expect(report.shadows).toBe(1);
        expect(report.findings[0].type).toBe("shadow");
        expect(report.findings[0].resource).toBe("out/shared.txt");
        expect(report.findings[0].ordering).toBe("implicit");
    });
});

// ─── No false positives ─────────────────────────────────────────────────────

describe("b4mal check — passes legitimate DAGs", () => {
    test("disjoint tasks verify cleanly", async () => {
        const dir = await fixture("disjoint", {
            tasks: {
                a: { cmd: ["sh", "-c", "echo a > out/a.txt"], outputs: ["out/a.txt"] },
                b: { cmd: ["sh", "-c", "echo b > out/b.txt"], outputs: ["out/b.txt"] },
            },
        });
        dirs.push(dir);

        const result = await runCLI(["check"], dir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/no collisions, no shadowing/);
    });

    test("a declared producer/consumer chain verifies cleanly", async () => {
        const dir = await fixture("chain", {
            tasks: {
                emit: { cmd: ["sh", "-c", "mkdir -p gen && echo x > gen/s.ts"], outputs: ["gen/s.ts"] },
                use: {
                    cmd: ["sh", "-c", "cat gen/s.ts"],
                    inputs: ["gen/s.ts"],
                    dependencies: ["emit"],
                },
            },
        });
        dirs.push(dir);

        const result = await runCLI(["check"], dir);
        expect(result.exitCode).toBe(0);
    });

    test("a declared overwrite is still reported, as declared ordering", async () => {
        const dir = await fixture("declared-overwrite", {
            tasks: {
                gen: { cmd: ["sh", "-c", "mkdir -p out && echo a > out/f.txt"], outputs: ["out/f.txt"] },
                patch: {
                    cmd: ["sh", "-c", "echo b >> out/f.txt"],
                    inputs: ["out/f.txt"],
                    outputs: ["out/f.txt"],
                    dependencies: ["gen"],
                },
            },
        });
        dirs.push(dir);

        const result = await runCLI(["check", "--json"], dir);
        expect(result.exitCode).toBe(1);

        const report = JSON.parse(result.stdout);
        expect(report.shadows).toBe(1);
        expect(report.findings[0].ordering).toBe("declared");
        expect(report.findings[0].upstream).toBe("gen");
        expect(report.findings[0].downstream).toBe("patch");
    });
});
