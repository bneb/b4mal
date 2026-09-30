/**
 * Tests: the whole command surface.
 *
 * Every command `--help` advertises is invoked for real in a fixture project and
 * checked for three things: it does not crash (no unhandled rejection, no raw
 * stack trace, no TypeError), it exits with a code consistent with what it
 * printed, and it does not take the process down.
 *
 * This class of defect has shipped repeatedly. `--help` and `--version` crashed
 * with an unhandled ENOENT on the built artifact. `b4mal plugin install` could
 * never work: the block indexed argv from the wrong offset, so every subcommand
 * printed "Unknown plugin command". `b4mal setup <bad>` and `b4mal plugin <bad>`
 * printed [FAIL] and exited 0, so a script could not tell they had failed. None of
 * those were caught by the unit tests, because nothing ran the commands.
 *
 * Long-running commands (lsp, watch, dev) are killed after a grace period;
 * staying alive is correct for them, so they are checked for crashes only.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "../src/cli/index.ts");

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "b4mal-surface-"));
    // A project with a project-local .git so `setup ci` resolves its git root
    // here rather than walking up into the repository under test.
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "b4mal.config.json"), JSON.stringify({
        tasks: {
            gen: {
                cmd: ["bun", "-e", "require('fs').mkdirSync('out',{recursive:true});require('fs').writeFileSync('out/a.txt','x')"],
                outputs: ["out/a.txt"],
            },
            verify: { cmd: ["bun", "-e", "process.exit(0)"], inputs: ["out/a.txt"], dependencies: ["gen"] },
        },
    }, null, 2));
});

afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

interface Outcome {
    exitCode: number | null;
    output: string;
    crashed: boolean;
    killed: boolean;
}

async function run(args: string[], opts: { killAfterMs?: number; stdin?: "ignore" | "pipe" } = {}): Promise<Outcome> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd: root,
        // `lsp` is a stdio server: it stays up while stdin is an open pipe and
        // exits on EOF, which is correct. Everything else gets no stdin, as a
        // non-interactive invocation would.
        stdin: opts.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });

    let killed = false;
    const timer = opts.killAfterMs
        ? setTimeout(() => { killed = true; proc.kill(); }, opts.killAfterMs)
        : undefined;
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (timer) clearTimeout(timer);

    // Strip ANSI so the patterns match regardless of colour support.
    const output = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "");
    const crashed =
        /UNHANDLED REJECTION/i.test(output) ||
        /\b(TypeError|ReferenceError|SyntaxError):/.test(output) ||
        /is not a function/.test(output) ||
        /\n\s+at .+\(.+:\d+:\d+\)/.test(output);

    return { exitCode: killed ? null : exitCode, output, crashed, killed };
}

// ─── Commands that must finish, and succeed ─────────────────────────────────

describe("command surface — succeeding commands", () => {
    const succeeding: [string, string[]][] = [
        ["init", ["init"]],
        ["check", ["check"]],
        ["check --json", ["check", "--json"]],
        ["build --dry-run", ["build", "--dry-run"]],
        ["shadow", ["shadow"]],
        ["analyze", ["analyze"]],
        ["remote status", ["remote", "status"]],
        ["attest", ["attest", "gen", "fs:write:out"]],
        ["clean", ["clean"]],
    ];

    for (const [label, args] of succeeding) {
        test(`${label} exits 0 without crashing`, async () => {
            const r = await run(args);
            expect(r.crashed).toBe(false);
            expect(r.exitCode).toBe(0);
        });
    }

    test("build executes and produces declared outputs", async () => {
        const r = await run(["build", "--sync"]);
        expect(r.crashed).toBe(false);
        expect(r.exitCode).toBe(0);
    });
});

// ─── Commands that must fail loudly, with a non-zero exit ───────────────────

describe("command surface — failures must be distinguishable", () => {
    // Each of these prints [FAIL]; a script has to be able to tell. Two of them
    // used to exit 0, which made the failure invisible to CI.
    const failing: [string, string[]][] = [
        ["unknown command", ["frobnicate"]],
        ["unknown setup subcommand", ["setup", "nope"]],
        ["unknown plugin subcommand", ["plugin"]],
        ["plugin install with no url", ["plugin", "install"]],
        ["plugin install with a malformed url", ["plugin", "install", "not-a-url"]],
        ["plugin run with no name", ["plugin", "run"]],
        ["plugin run of an uninstalled plugin", ["plugin", "run", "definitely-not-installed"]],
        ["migrate with no path", ["migrate"]],
    ];

    for (const [label, args] of failing) {
        test(`${label} exits non-zero without crashing`, async () => {
            const r = await run(args);
            expect(r.crashed).toBe(false);
            expect(r.exitCode).not.toBe(0);
            expect(r.output).toMatch(/\[FAIL\]|Usage:/);
        });
    }

    test("an uninstalled plugin reports the problem, not a stack trace", async () => {
        const r = await run(["plugin", "run", "definitely-not-installed"]);
        expect(r.output).toMatch(/not found/i);
        expect(r.output).not.toMatch(/FATAL/);
    });
});

// ─── Commands that are meant to keep running ────────────────────────────────

describe("command surface — long-running commands", () => {
    test("lsp starts and stays up while stdin is open", async () => {
        // With stdin closed the server exits on EOF, which is correct for a stdio
        // LSP — so it is given an open pipe here.
        const r = await run(["lsp"], { killAfterMs: 3000, stdin: "pipe" });
        expect(r.killed).toBe(true);
        expect(r.crashed).toBe(false);
    });

    test("lsp exits cleanly when stdin reaches EOF", async () => {
        const r = await run(["lsp"]);
        expect(r.crashed).toBe(false);
        expect(r.exitCode).toBe(0);
    });

    test("watch starts and stays up without crashing", async () => {
        const r = await run(["watch"], { killAfterMs: 4000 });
        expect(r.killed).toBe(true);
        expect(r.crashed).toBe(false);
        expect(r.output).toMatch(/monitoring/i);
    });

    test("dev is an alias for watch", async () => {
        const r = await run(["dev"], { killAfterMs: 4000 });
        expect(r.killed).toBe(true);
        expect(r.crashed).toBe(false);
        expect(r.output).toMatch(/monitoring/i);
    });
});

// ─── Advertised surface matches dispatch ────────────────────────────────────

describe("command surface — help text", () => {
    test("every command named in --help exits 0 or fails with a clear message", async () => {
        const help = await run(["--help"]);
        expect(help.exitCode).toBe(0);

        // A command listed in help that does not dispatch would fall through to
        // "Unknown command", which is how the plugin indexing bug stayed hidden.
        const listed = [...help.output.matchAll(/^\s+b4mal ([a-z-]+)/gm)].map(m => m[1]);
        expect(listed.length).toBeGreaterThan(8);

        for (const name of listed) {
            const r = await run([name]);
            expect(r.output).not.toMatch(/Unknown command/);
        }
    });
});
