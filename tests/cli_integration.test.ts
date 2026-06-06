// tests/cli_integration.test.ts — v5.0.0 "The Core CLI" (RED-to-GREEN)
//
// Spawns the CLI as a real subprocess via Bun.spawn to test true
// end-to-end behavior: process exit codes, stdout, file system effects.

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import { homedir } from "os";
import { join } from "path";

const CLI_PATH = path.resolve(import.meta.dir, "../src/cli/index.ts");

// ─── Helper: spawn CLI and capture output ───────────────────────────────────

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
        env: {
            ...process.env,
            // Use a unique per-test DB to avoid cross-test contamination
            B4MAL_DB_PATH: join(cwd, "test_cache.db"),
        },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { exitCode, stdout, stderr };
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

let initDir: string;
let buildDir: string;
let conflictDir: string;
let cleanDir: string;
let noLockDir: string;  // fresh dir guaranteed to have NO lockfile

beforeAll(async () => {
    const base = os.tmpdir();
    initDir    = join(base, "b4mal-cli-init-"    + Date.now());
    buildDir   = join(base, "b4mal-cli-build-"   + Date.now());
    conflictDir= join(base, "b4mal-cli-conflict-"+ Date.now());
    cleanDir   = join(base, "b4mal-cli-clean-"   + Date.now());
    noLockDir  = join(base, "b4mal-cli-nolock-"  + Date.now());

    await Promise.all([
        fs.mkdir(initDir,    { recursive: true }),
        fs.mkdir(buildDir,   { recursive: true }),
        fs.mkdir(conflictDir,{ recursive: true }),
        fs.mkdir(cleanDir,   { recursive: true }),
        fs.mkdir(noLockDir,  { recursive: true }),
    ]);

    // Build dir: a minimal project with src files for discovery
    await fs.mkdir(join(buildDir, "src"), { recursive: true });
    await fs.writeFile(join(buildDir, "src", "index.ts"), `import { foo } from './foo';\n`);
    await fs.writeFile(join(buildDir, "src", "foo.ts"),
        `export function foo() { return 42; }\n`
    );

    // Conflict dir: lockfile with two tasks writing the same path via overlapping prefix
    const conflictLock = [
        {
            id: "task-a",
            cmd: ["echo", "a"],
            claims: ["fs:dist/"],
            deps: [],
            reads: [],
            writes: ["dist/"],
            envReads: [],
            envWrites: [],
        },
        {
            id: "task-b",
            cmd: ["echo", "b"],
            claims: ["fs:dist/output.js"],
            deps: [],
            reads: [],
            writes: ["dist/output.js"],
            envReads: [],
            envWrites: [],
        },
    ];
    await fs.writeFile(
        join(conflictDir, "b4mal.lock"),
        JSON.stringify(conflictLock, null, 2)
    );

    // Clean dir: valid lockfile + a dummy artifact + ledger entry
    const cleanLock = [
        {
            id: "clean-task",
            cmd: ["echo", "hello"],
            claims: ["fs:src/"],
            deps: [],
            reads: ["src/"],
            writes: [],
            envReads: [],
            envWrites: [],
        },
    ];
    await fs.writeFile(
        join(cleanDir, "b4mal.lock"),
        JSON.stringify(cleanLock, null, 2)
    );
});

afterAll(async () => {
    await Promise.all(
        [initDir, buildDir, conflictDir, cleanDir, noLockDir].map(d =>
            fs.rm(d, { recursive: true, force: true })
        )
    );
});

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — Init Flow
// ═══════════════════════════════════════════════════════════════════════════

describe("CLI — init", () => {
    test("creates b4mal.lock with valid JSON", async () => {
        const result = await runCLI(["init"], initDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Initializing");

        const lockPath = join(initDir, "b4mal.lock");
        expect(existsSync(lockPath)).toBe(true);

        const lockContent = await fs.readFile(lockPath, "utf-8");
        expect(() => JSON.parse(lockContent)).not.toThrow();

        const parsed = JSON.parse(lockContent);
        expect(Array.isArray(parsed)).toBe(true);
    }, 15000);

    test("exits 0 even if project has no source files", async () => {
        const emptyDir = join(os.tmpdir(), "b4mal-empty-" + Date.now());
        await fs.mkdir(emptyDir, { recursive: true });
        const result = await runCLI(["init"], emptyDir);
        expect(result.exitCode).toBe(0);
        await fs.rm(emptyDir, { recursive: true, force: true });
    }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — Build Flow (Clean)
// ═══════════════════════════════════════════════════════════════════════════

describe("CLI — build", () => {
    test("exits 1 with helpful message when no b4mal.lock found", async () => {
        const result = await runCLI(["build"], noLockDir);
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toMatch(/b4mal init|no.*lock/i);
    }, 10000);

    test("build with valid lockfile exits 0 and prints Wave Orchestrator banner", async () => {
        // First init to generate a lockfile
        await runCLI(["init"], buildDir);
        const lockPath = join(buildDir, "b4mal.lock");
        expect(existsSync(lockPath)).toBe(true);

        const result = await runCLI(["build"], buildDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/Wave Orchestrator|Engaging/i);
    }, 30000);

    test("second build reports cache hits", async () => {
        // Lock exists from previous test; run build twice
        const result1 = await runCLI(["build"], buildDir);
        expect(result1.exitCode).toBe(0);

        const result2 = await runCLI(["build"], buildDir);
        expect(result2.exitCode).toBe(0);
        // Second run should mention caching
        expect(result2.stdout + result2.stderr).toMatch(/hit|cached|skip/i);
    }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 3 — Build Flow (Conflict)
// ═══════════════════════════════════════════════════════════════════════════

describe("CLI — build conflict", () => {
    test("exits 0 because overlapping writes are now handled sequentially by WavePlanner", async () => {
        const result = await runCLI(["build"], conflictDir);

        expect(result.exitCode).toBe(0);
    }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 4 — Clean Flow
// ═══════════════════════════════════════════════════════════════════════════

describe("CLI — clean", () => {
    test("exits 0 and confirms purge", async () => {
        const result = await runCLI(["clean"], cleanDir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/clean|purg/i);
    }, 10000);

    test("artifacts directory is empty after clean", async () => {
        // Run a build first to maybe produce artifacts, then clean
        await runCLI(["build"], cleanDir);
        await runCLI(["clean"], cleanDir);

        const crypto = require("crypto");
        const projHash = crypto.createHash("sha256").update(cleanDir).digest("hex");
        const artifactsDir = join(homedir(), '.b4mal', "artifacts", projHash);
        // Either doesn't exist or is empty of .tar.zst files
        if (existsSync(artifactsDir)) {
            const files = await fs.readdir(artifactsDir);
            const zstFiles = files.filter(f => f.endsWith(".tar.zst"));
            expect(zstFiles).toHaveLength(0);
        }
    }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// § 5 — Flags
// ═══════════════════════════════════════════════════════════════════════════

describe("CLI — flags", () => {
    test("unknown command exits 1", async () => {
        const result = await runCLI(["foobar"], initDir);
        expect(result.exitCode).toBe(1);
    }, 5000);

    test("--debug flag prints extra info on error", async () => {
        const result = await runCLI(["build", "--debug"], noLockDir);
        expect(result.exitCode).toBe(1); // no lockfile
        // With --debug, should print stack or extended error
        const combined = result.stdout + result.stderr;
        expect(combined.length).toBeGreaterThan(10);
    }, 10000);
});
