// tests/showpiece.test.ts — v6.0.0 "The Showpiece" Test Suite
//
// RED → GREEN TDD covering:
//   §1–§5   b4mal demo command (Z3 collision intercept output)
//   §6–§11  scripts/install.sh (static validation — no network required)
//
// The demo command is the centrepiece: an engineer runs `b4mal demo`
// and sees a real Z3 proof halt execution on a baked-in race condition.
// No project, no config, no network. Just math.

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import { join } from "path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const CLI_PATH    = join(PROJECT_ROOT, "src/cli/index.ts");
const INSTALL_SH  = join(PROJECT_ROOT, "scripts/install.sh");

// ─── Helper ──────────────────────────────────────────────────────────────────

interface CLIResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    combined: string;
}

async function runCLI(args: string[]): Promise<CLIResult> {
    const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stdout, stderr, combined: stdout + stderr };
}

// ═══════════════════════════════════════════════════════════════════════════
// §1-§5  b4mal demo — Z3 Collision Interceptor
// ═══════════════════════════════════════════════════════════════════════════

describe("b4mal demo — Z3 Collision Interceptor", () => {
    let result: CLIResult;

    beforeAll(async () => {
        result = await runCLI(["demo"]);
    }, 30000);

    // §1 — Demo always exits 1 (collision proved; build halted)
    test("§1 exits 1 — collision is fatal", () => {
        expect(result.exitCode).toBe(1);
    });

    // §2 — The headline collision message is present
    test("§2 output contains MATHEMATICAL COLLISION DETECTED", () => {
        expect(result.combined).toMatch(/MATHEMATICAL COLLISION DETECTED/i);
    });

    // §3 — The witness path is printed (the exact file Z3 found)
    test("§3 output contains the colliding file path witness", () => {
        // The demo scenario: integration_suite_a and _b both write tests/fixtures/tmp.sqlite
        expect(result.combined).toMatch(/tests\/fixtures\/tmp\.sqlite/);
    });

    // §4 — The SMT-LIB2 formula is shown to prove this is real math
    test("§4 output contains SMT-LIB2 formula fragment", () => {
        // Must show the QF_S constraint that proved the collision
        expect(result.combined).toMatch(/check-sat|str\.prefixof|QF_S/i);
    });

    // §5 — A suggested remediation is printed
    test("§5 output contains fix suggestion", () => {
        expect(result.combined).toMatch(/sequenti|dep|fix|isolat/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// §6-§11  scripts/install.sh — Static Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("scripts/install.sh — static validation", () => {
    let script: string;

    beforeAll(async () => {
        script = await fs.readFile(INSTALL_SH, "utf-8");
    });

    // §6 — Script file exists
    test("§6 install.sh exists", () => {
        expect(existsSync(INSTALL_SH)).toBe(true);
    });

    // §7 — Strict mode must be on line 2 or 3
    test("§7 contains set -euo pipefail", () => {
        expect(script).toContain("set -euo pipefail");
        // Must appear near top of file, not buried
        const lines = script.split("\n");
        const strictLine = lines.findIndex(l => l.includes("set -euo pipefail"));
        expect(strictLine).toBeGreaterThanOrEqual(1);
        expect(strictLine).toBeLessThanOrEqual(4);
    });

    // §8 — Bun is a hard requirement
    test("§8 checks for bun and exits with helpful error", () => {
        expect(script).toMatch(/command -v bun/);
        expect(script).toMatch(/bun\.sh\/install/);
    });

    // §9 — Z3 is a soft warning (not fatal)
    test("§9 warns about missing z3 but does not exit", () => {
        expect(script).toMatch(/command -v z3/);
        // Must be a warning (echo) not a hard exit
        const z3Block = script.slice(
            script.indexOf("command -v z3"),
            script.indexOf("command -v z3") + 200,
        );
        expect(z3Block).toMatch(/echo/);
        // z3 check must NOT be followed immediately by `exit 1`
        expect(z3Block).not.toMatch(/exit 1/);
    });

    // §10 — Uses bun build --compile to produce a standalone binary
    test("§10 compiles with bun build --compile", () => {
        expect(script).toMatch(/bun build/);
        expect(script).toMatch(/--compile/);
        expect(script).toMatch(/--outfile/);
    });

    // §11 — Installs to ~/.local/bin with a PATH hint
    test("§11 installs to ~/.local/bin and hints about PATH", () => {
        expect(script).toMatch(/\.local\/bin/);
        expect(script).toMatch(/PATH/);
    });
});
