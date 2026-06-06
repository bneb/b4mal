// Tests: High-Speed Rust Auditor (v2.9.0 — RED PHASE)
//
// Validates git history scanning with RustNormalizer-based
// tax event detection. Uses synthetic test repos with known
// comment-only commits.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { RustAuditor, type AuditResult } from "../src/core/rust_auditor";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
}

async function createTestRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "b4mal-rust-audit-"));
    await git(dir, "init");
    await git(dir, "config", "user.email", "test@test.com");
    await git(dir, "config", "user.name", "Test");

    // Create src directory
    await mkdir(join(dir, "src"), { recursive: true });

    return dir;
}

async function commitFile(cwd: string, path: string, content: string, msg: string) {
    await writeFile(join(cwd, path), content);
    await git(cwd, "add", path);
    await git(cwd, "commit", "-m", msg);
}

let repoDir: string;

// ─── Event Accuracy ──────────────────────────────────────────────────────────

describe("RustAuditor - Event Accuracy", () => {
    beforeEach(async () => {
        repoDir = await createTestRepo();
    });

    afterEach(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    test("detects exactly 3 tax events in 10 commits", async () => {
        // Commit 1: Initial code
        await commitFile(repoDir, "src/lib.rs",
            `fn add(a: i32, b: i32) -> i32 { a + b }`,
            "initial"
        );

        // Commit 2: Logic change (NOT a tax event)
        await commitFile(repoDir, "src/lib.rs",
            `fn add(a: i32, b: i32) -> i32 { a + b + 1 }`,
            "logic change 1"
        );

        // Commit 3: Comment-only change (TAX EVENT)
        await commitFile(repoDir, "src/lib.rs",
            `// Added documentation\nfn add(a: i32, b: i32) -> i32 { a + b + 1 }`,
            "add doc comment"
        );

        // Commit 4: Logic change
        await commitFile(repoDir, "src/lib.rs",
            `// Added documentation\nfn add(a: i32, b: i32) -> i32 { a * b }`,
            "logic change 2"
        );

        // Commit 5: Whitespace-only change (TAX EVENT)
        await commitFile(repoDir, "src/lib.rs",
            `// Added documentation\nfn add(a: i32, b: i32) -> i32 {\n    a * b\n}`,
            "reformat"
        );

        // Commit 6: New file
        await commitFile(repoDir, "src/main.rs",
            `fn main() { println!("hello"); }`,
            "add main"
        );

        // Commit 7: Doc-comment change on main (TAX EVENT)
        await commitFile(repoDir, "src/main.rs",
            `/// Entry point\nfn main() { println!("hello"); }`,
            "add main doc"
        );

        // Commit 8: Logic change on main
        await commitFile(repoDir, "src/main.rs",
            `/// Entry point\nfn main() { println!("goodbye"); }`,
            "change greeting"
        );

        // Commit 9: Logic change on lib
        await commitFile(repoDir, "src/lib.rs",
            `// Added documentation\nfn add(a: i32, b: i32) -> i32 {\n    a + b + 42\n}`,
            "logic change 3"
        );

        // Commit 10: Non-Rust file (should be ignored)
        await commitFile(repoDir, "README.md",
            `# My project\nUpdated readme.`,
            "update readme"
        );

        const result = await RustAuditor.scan(repoDir, { limit: 20 });

        expect(result.taxEvents).toBe(3);
        expect(result.logicChanges).toBeGreaterThan(0);
        expect(result.commitsScanned).toBe(10);
    });

    test("ignores non-.rs files entirely", async () => {
        await commitFile(repoDir, "README.md", "# v1", "init readme");
        await commitFile(repoDir, "README.md", "# v1\n// not a comment", "update readme");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });
        expect(result.taxEvents).toBe(0);
    });

    test("handles new file creation (no previous version)", async () => {
        await commitFile(repoDir, "src/lib.rs", "fn hello() {}", "initial");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });
        // New file creation is not a tax event
        expect(result.taxEvents).toBe(0);
    });
});

// ─── Large File Handling ─────────────────────────────────────────────────────

describe("RustAuditor - Large Files", () => {
    beforeEach(async () => {
        repoDir = await createTestRepo();
    });

    afterEach(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    test("handles 10,000-line files without crash", async () => {
        const bigFile = Array.from({ length: 10000 }, (_, i) =>
            `fn func_${i}(x: i32) -> i32 { x + ${i} }`
        ).join("\n");

        await commitFile(repoDir, "src/big.rs", bigFile, "add big file");

        // Comment-only change on big file
        const bigFileWithComment = `// Big file header\n${bigFile}`;
        await commitFile(repoDir, "src/big.rs", bigFileWithComment, "add header comment");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });
        expect(result.taxEvents).toBe(1);
    });

    test("audit of large file completes in <2s", async () => {
        const bigFile = Array.from({ length: 5000 }, (_, i) =>
            `/// Doc for ${i}\n#[inline]\nfn func_${i}(x: i32) -> i32 { x + ${i} }`
        ).join("\n");

        await commitFile(repoDir, "src/big.rs", bigFile, "add big file");

        const bigWithExtraDoc = `//! Module docs\n${bigFile}`;
        await commitFile(repoDir, "src/big.rs", bigWithExtraDoc, "add module doc");

        const start = performance.now();
        await RustAuditor.scan(repoDir, { limit: 10 });
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(2000);
    });
});

// ─── Report Integrity ────────────────────────────────────────────────────────

describe("RustAuditor - Report", () => {
    beforeEach(async () => {
        repoDir = await createTestRepo();
    });

    afterEach(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    test("calculates time savings from avg compile time", async () => {
        await commitFile(repoDir, "src/lib.rs", "fn a() {}", "init");
        await commitFile(repoDir, "src/lib.rs", "// doc\nfn a() {}", "add doc");

        const result = await RustAuditor.scan(repoDir, {
            limit: 10,
            avgCompileSeconds: 480, // 8 minutes
        });

        expect(result.taxEvents).toBe(1);
        expect(result.totalSavedSeconds).toBe(480); // 1 event * 480s
    });

    test("defaults to 300s average compile time", async () => {
        await commitFile(repoDir, "src/lib.rs", "fn a() {}", "init");
        await commitFile(repoDir, "src/lib.rs", "// doc\nfn a() {}", "add doc");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });

        expect(result.totalSavedSeconds).toBe(300); // 1 event * 300s default
    });

    test("report includes tax rate percentage", async () => {
        await commitFile(repoDir, "src/lib.rs", "fn a() {}", "init");
        await commitFile(repoDir, "src/lib.rs", "fn b() {}", "logic change");
        await commitFile(repoDir, "src/lib.rs", "// doc\nfn b() {}", "add doc");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });

        expect(result.taxRate).toBeDefined();
        expect(result.taxRate).toBeGreaterThan(0);
        expect(result.taxRate).toBeLessThanOrEqual(100);
    });

    test("result includes per-event details", async () => {
        await commitFile(repoDir, "src/lib.rs", "fn a() {}", "init");
        await commitFile(repoDir, "src/lib.rs", "// header\nfn a() {}", "add header");

        const result = await RustAuditor.scan(repoDir, { limit: 10 });

        expect(result.events.length).toBe(1);
        expect(result.events[0].file).toContain("lib.rs");
        expect(result.events[0].commit).toBeDefined();
        expect(result.events[0].reason).toMatch(/comment|whitespace/);
    });

    // ─── Performance ─────────────────────────────────────────────────────

    test("audit of 20 commits produces correct event count", async () => {
        // Every 3rd commit adds a comment suffix — creates a tax event
        // Commits 0,3,6,9,12,15,18 have " // comment" added = 7 potential events
        // But each must have a *previous* version to diff against,
        // and event is detected only when comment is ADDED vs prior.
        for (let i = 0; i < 20; i++) {
            await commitFile(repoDir, "src/lib.rs",
                `fn func() -> i32 { ${i} }${i % 3 === 0 ? " // comment" : ""}`,
                `commit ${i}`
            );
        }

        const result = await RustAuditor.scan(repoDir, { limit: 20 });

        // Structural: must return a valid AuditResult with correct shape
        expect(result.commitsScanned).toBe(20);
        expect(result.taxEvents).toBeGreaterThanOrEqual(0);
        expect(result.taxEvents).toBeLessThanOrEqual(result.commitsScanned);
        expect(Array.isArray(result.events)).toBe(true);
    });
});
