/**
 * Tests: the b4mal GitHub Action.
 *
 * The action is the intended front door — "add five lines and see a race in your
 * own build" — so the pieces it depends on are pinned here:
 *
 *   1. `b4mal check --json` writes ONLY the JSON to stdout, even when the
 *      surrounding action shell would emit anything else, and exits 1 on findings
 *      while still producing a report. (A GITHUB_OUTPUT-unaware consumer that
 *      pipes this to jq is exactly the audience.)
 *   2. scripts/b4mal-report.mjs maps a report to annotations and outputs, with
 *      workflow-command escaping that is easy to get subtly wrong.
 *   3. A repo with no b4mal files is a no-op, so the action can be added
 *      without red-lining projects that do not use b4mal.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(import.meta.dir, "../src/cli/index.ts");
const REPORT = join(import.meta.dir, "../scripts/b4mal-report.mjs");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4mal-action-"));
});

afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

async function checkJson(cwd: string) {
    const proc = Bun.spawn(["bun", CLI, "check", "--json"], {
        cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

async function runReport(reportPath: string, extra: string[] = []) {
    const proc = Bun.spawn(["node", REPORT, reportPath, ...extra], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

// ─── The CLI contract the action relies on ──────────────────────────────────

describe("check --json (the action's input)", () => {
    test("stdout is only the JSON when a config has a finding", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), JSON.stringify({
            tasks: {
                a: { cmd: ["echo", "a"], outputs: ["out/s.txt"] },
                b: { cmd: ["echo", "b"], outputs: ["out/s.txt"] },
            },
        }));
        const r = await checkJson(dir);
        expect(() => JSON.parse(r.stdout)).not.toThrow();
        expect(r.exitCode).toBe(1);            // findings
        expect(JSON.parse(r.stdout).verified).toBe(false);
    });

    test("stdout is only the JSON when there are no findings", async () => {
        writeFileSync(join(dir, "b4mal.config.json"), JSON.stringify({
            tasks: { a: { cmd: ["echo", "a"], outputs: ["out/a.txt"] } },
        }));
        const r = await checkJson(dir);
        expect(() => JSON.parse(r.stdout)).not.toThrow();
        expect(r.exitCode).toBe(0);
    });
});

// ─── The report → annotations/outputs mapping ───────────────────────────────

describe("b4mal-report.mjs", () => {
    const writeReport = (obj: unknown) => {
        const p = join(dir, "report.json");
        writeFileSync(p, JSON.stringify(obj));
        return p;
    };

    test("maps collisions to ::error and shadows to ::warning", async () => {
        const p = writeReport({
            verified: false, collisions: 1, shadows: 1,
            findings: [
                { type: "collision", message: "Collision: x vs y on dist/" },
                { type: "shadow", message: "beta masks alpha at out/a.txt" },
            ],
        });
        const r = await runReport(p, ["--file", "b4mal.config.json"]);
        expect(r.stdout).toContain("::error file=b4mal.config.json::Collision: x vs y on dist/");
        expect(r.stdout).toContain("::warning file=b4mal.config.json::beta masks alpha");
    });

    test("counts implicit dependencies", async () => {
        const p = writeReport({
            verified: false, collisions: 0, shadows: 0,
            findings: [
                { type: "implicit-dependency", message: "Implicit dependency: b reads a produced by a" },
            ],
        });
        const r = await runReport(p);
        expect(r.stdout).toContain("::warning::Implicit dependency");
    });

    test("escapes characters that would break a workflow command", async () => {
        // A newline in a message would split the annotation; % starts an escape.
        const p = writeReport({
            verified: false, collisions: 1, shadows: 0,
            findings: [{ type: "collision", message: "line1\nline2 100% bad" }],
        });
        const r = await runReport(p);
        // The whole message stays on one line, with % escaped.
        const line = r.stdout.split("\n").find(l => l.startsWith("::error"))!;
        expect(line).toContain("%0A");
        expect(line).toContain("%25");
        // No raw newline leaked into the middle of the annotation.
        expect(line).not.toContain("line1\nline2");
    });

    test("escapes , and : in a file property", async () => {
        const p = writeReport({ verified: false, collisions: 1, shadows: 0, findings: [{ type: "collision", message: "x" }] });
        const r = await runReport(p, ["--file", "we,ird:name.json"]);
        expect(r.stdout).toContain("file=we%2Cird%3Aname.json");
    });

    test("passes through the empty-lockfile note", async () => {
        writeFileSync(join(dir, "b4mal.lock"), "[]");
        const r = await checkJson(dir);
        const p = writeReport(JSON.parse(r.stdout));
        const out = await runReport(p);
        expect(out.stdout).toContain("::notice::");
        expect(out.stdout).toMatch(/nothing was verified/);
    });

    test("a missing report is treated as nothing to audit, not an error", async () => {
        const r = await runReport(join(dir, "does-not-exist.json"));
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("nothing to audit");
    });

    test("invalid JSON reports an error rather than throwing", async () => {
        const p = join(dir, "bad.json");
        writeFileSync(p, "{not json");
        const r = await runReport(p);
        expect(r.stdout).toContain("::error::");
        expect(r.exitCode).toBe(0); // the action decides the gate
    });

    test("writes the documented outputs when GITHUB_OUTPUT is set", async () => {
        const outFile = join(dir, "gh_output");
        writeFileSync(outFile, "");
        const p = writeReport({
            verified: false, collisions: 1, shadows: 1,
            findings: [
                { type: "collision", message: "a" },
                { type: "shadow", message: "b" },
            ],
        });
        const proc = Bun.spawn(["node", REPORT, p], {
            stdout: "pipe", stderr: "pipe",
            env: { ...process.env, GITHUB_OUTPUT: outFile },
        });
        await proc.exited;
        const contents = readFileSync(outFile, "utf-8");
        expect(contents).toMatch(/^verified=false$/m);
        expect(contents).toMatch(/^collisions=1$/m);
        expect(contents).toMatch(/^shadows=1$/m);
    });
});

// ─── A repository that does not use b4mal is a no-op ──────────────────────

describe("action applied to a non-b4mal repository", () => {
    test("check --json fails cleanly with no b4mal files, and the report script exits 0", async () => {
        // The action's "Look for a b4mal project" step gates on file presence; if
        // that gate is ever wrong, the report script must not hard-fail.
        const r = await checkJson(dir);
        const p = join(dir, "report.json");
        writeFileSync(p, r.stdout || "{}");
        const out = await runReport(p);
        expect(out.exitCode).toBe(0);
    });
});
