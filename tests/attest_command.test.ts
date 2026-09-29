/**
 * Tests: `b4mal attest`.
 *
 * The handler in src/cli/attest.ts was complete but unreachable — no CLI case
 * dispatched to it, and nothing imported it, so `crates/b4mal`'s `attest()`
 * shelled out to a command that did not exist and always failed. Both are now
 * wired; these tests pin the argument grammar and the wire format the Rust crate
 * depends on.
 */
import { describe, test, expect } from "bun:test";
import { join } from "path";
import { AttestHandler } from "../src/cli/attest";

const CLI = join(import.meta.dir, "../src/cli/index.ts");

async function runCli(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", CLI, "attest", ...args], {
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

// ─── Argument grammar ───────────────────────────────────────────────────────

describe("AttestHandler.parseArgs", () => {
    test("maps each documented protocol prefix", () => {
        const parsed = AttestHandler.parseArgs([
            "build",
            "fs:read:src",
            "fs:write:dist",
            "fs:bare",
            "env:read:NODE_ENV",
            "env:PLAIN",
            "env:write:PORT",
            "port:8080",
        ]);

        expect(parsed.taskName).toBe("build");
        expect(parsed.reads).toEqual(["src", "bare"]);      // bare fs: defaults to read
        expect(parsed.writes).toEqual(["dist"]);
        expect(parsed.envReads).toEqual(["NODE_ENV", "PLAIN"]);
        expect(parsed.envWrites).toEqual(["PORT"]);
        expect(parsed.ports).toEqual(["8080"]);
    });

    test("env:read: is not mistaken for a variable literally named 'read:…'", () => {
        // Regression: only fs:read: was handled explicitly, so env:read:X fell
        // through to the bare `env:` branch and produced the variable name
        // "read:X" — silently wrong rather than an error.
        const parsed = AttestHandler.parseArgs(["t", "env:read:TOKEN"]);
        expect(parsed.envReads).toEqual(["TOKEN"]);
    });

    test("ignores unrecognised prefixes rather than guessing", () => {
        const parsed = AttestHandler.parseArgs(["t", "nonsense", "fs:read:src", ":weird"]);
        expect(parsed.reads).toEqual(["src"]);
        expect(parsed.writes).toEqual([]);
        expect(parsed.envReads).toEqual([]);
    });

    test("ports are modelled as exclusive writes", () => {
        const claim = AttestHandler.toClaim(AttestHandler.parseArgs(["t", "port:3000"]));
        expect(claim.writes).toEqual(["port:3000"]);
        expect(claim.id).toBe("t");
    });
});

// ─── Caller identity ────────────────────────────────────────────────────────

describe("AttestHandler.identifyCaller", () => {
    test("splits name-version from B4MAL_CALLER", () => {
        expect(AttestHandler.identifyCaller({ B4MAL_CALLER: "rust-shim-v1.3.0" }))
            .toEqual({ name: "rust-shim", version: "v1.3.0" });
    });

    test("falls back to unknown when unset", () => {
        expect(AttestHandler.identifyCaller({})).toEqual({ name: "unknown", version: "unknown" });
    });

    test("handles a caller without a version suffix", () => {
        expect(AttestHandler.identifyCaller({ B4MAL_CALLER: "shim" }))
            .toEqual({ name: "shim", version: "unknown" });
    });
});

// ─── Wire format (what the Rust crate parses) ───────────────────────────────

describe("b4mal attest — CLI contract", () => {
    test("prints a JSON result and exits 0 on an accepted declaration", async () => {
        const result = await runCli(["build", "fs:write:dist", "env:NODE_ENV"]);

        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.accepted).toBe(true);
        expect(parsed.taskName).toBe("build");
        expect(parsed.claim.writes).toEqual(["dist"]);
        expect(parsed.claim.envReads).toEqual(["NODE_ENV"]);
    });

    test("exits 1 with a reason when the task name is missing", async () => {
        const result = await runCli([]);

        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.accepted).toBe(false);
        expect(parsed.error).toMatch(/task name/i);
    });

    test("reports the calling shim", async () => {
        const result = await runCli(["t", "fs:read:."], { B4MAL_CALLER: "rust-shim-v0.1.0" });
        const parsed = JSON.parse(result.stdout);
        expect(parsed.caller).toEqual({ name: "rust-shim", version: "v0.1.0" });
    });

    test("--help lists attest", async () => {
        const proc = Bun.spawn(["bun", CLI, "--help"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        expect(stdout).toMatch(/b4mal attest/);
    });
});
