/**
 * Tests: Git History Audit Engine (RED PHASE)
 *
 * Validates shadow AST transpilation, tax event detection,
 * structural change detection, and edge cases.
 *
 * Uses in-memory file pairs instead of git to test the core logic,
 * then tests the git integration separately.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
    AuditEngine,
    classifyDiff,
    type DiffClassification,
    type AuditReport,
} from "../src/core/audit_engine";

// ─── Core Logic: classifyDiff ─────────────────────────────────────────────────

describe("classifyDiff", () => {
    test("comment-only change is a TAX_EVENT", () => {
        const before = `
const x = 1;
const y = x + 2;
export function add(a: number, b: number) { return a + b; }
`;
        const after = `
// Updated: 2026-03-04
const x = 1;
// This performs addition
const y = x + 2;
export function add(a: number, b: number) { return a + b; }
`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(true);
        expect(result.reason).toContain("comment");
    });

    test("type-only change is a TAX_EVENT", () => {
        const before = `
const x: number = 1;
function greet(name: string): string { return "hi " + name; }
`;
        const after = `
const x: number | undefined = 1;
interface Greeter { greet(name: string): string; }
function greet(name: string): string { return "hi " + name; }
`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(true);
        expect(result.reason).toContain("type");
    });

    test("whitespace-only change is a TAX_EVENT", () => {
        const before = `const x=1;function foo(){return x;}`;
        const after = `const x = 1;\n\nfunction foo() {\n  return x;\n}\n`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(true);
    });

    test("logic change (new return value) is NOT a TAX_EVENT", () => {
        const before = `export function add(a: number, b: number) { return a + b; }`;
        const after = `export function add(a: number, b: number) { return a * b; }`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(false);
    });

    test("adding console.log is NOT a TAX_EVENT", () => {
        const before = `export function run() { return 42; }`;
        const after = `export function run() { console.log("running"); return 42; }`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(false);
    });

    test("adding a new function is NOT a TAX_EVENT", () => {
        const before = `export const x = 1;`;
        const after = `export const x = 1;\nexport function newFn() { return 2; }`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(false);
    });

    test("identical files are NOT a TAX_EVENT", () => {
        const content = `const x = 1;`;
        const result = classifyDiff(content, content);
        expect(result.isTaxEvent).toBe(false);
        expect(result.reason).toContain("identical");
    });

    test("mixed change (comment + logic) is NOT a TAX_EVENT", () => {
        const before = `
const x = 1;
export function foo() { return x; }
`;
        const after = `
// Changed logic
const x = 2;
export function foo() { return x * 2; }
`;
        const result = classifyDiff(before, after);
        expect(result.isTaxEvent).toBe(false);
    });
});

// ─── AuditEngine with git ─────────────────────────────────────────────────────

describe("AuditEngine", () => {
    let repoDir: string;

    beforeEach(async () => {
        repoDir = await mkdtemp(join(tmpdir(), "b4mal-audit-"));
        // Init a git repo
        await Bun.spawn(["git", "init"], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "config", "user.name", "Test"], { cwd: repoDir, stderr: "pipe" }).exited;
    });

    afterEach(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    test("detects comment-only commits as tax events", async () => {
        // Commit 1: initial logic
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "app.ts"), `export const x = 1;\nexport function add(a: number, b: number) { return a + b; }\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stderr: "pipe" }).exited;

        // Commit 2: comment-only change
        await writeFile(join(repoDir, "src", "app.ts"), `// Added docs\nexport const x = 1;\n// Helper function\nexport function add(a: number, b: number) { return a + b; }\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "add comments"], { cwd: repoDir, stderr: "pipe" }).exited;

        const report = await AuditEngine.run({ cwd: repoDir, limit: 10 });
        expect(report.taxEvents).toBeGreaterThanOrEqual(1);
    });

    test("does not flag logic changes as tax events", async () => {
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "math.ts"), `export function calc() { return 1; }\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: repoDir, stderr: "pipe" }).exited;

        await writeFile(join(repoDir, "src", "math.ts"), `export function calc() { return 42; }\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "change logic"], { cwd: repoDir, stderr: "pipe" }).exited;

        const report = await AuditEngine.run({ cwd: repoDir, limit: 10 });
        expect(report.taxEvents).toBe(0);
    });

    test("handles repo with fewer than N commits", async () => {
        await writeFile(join(repoDir, "README.md"), "# Hello");
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repoDir, stderr: "pipe" }).exited;

        const report = await AuditEngine.run({ cwd: repoDir, limit: 100 });
        expect(report.totalCommits).toBeLessThanOrEqual(1);
        expect(report.taxEvents).toBe(0);
    });

    test("report includes time recovered estimate", async () => {
        await mkdir(join(repoDir, "src"), { recursive: true });
        await writeFile(join(repoDir, "src", "a.ts"), `const a = 1;\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repoDir, stderr: "pipe" }).exited;

        // Comment-only change
        await writeFile(join(repoDir, "src", "a.ts"), `// Added doc\nconst a = 1;\n`);
        await Bun.spawn(["git", "add", "."], { cwd: repoDir, stderr: "pipe" }).exited;
        await Bun.spawn(["git", "commit", "-m", "docs"], { cwd: repoDir, stderr: "pipe" }).exited;

        const report = await AuditEngine.run({ cwd: repoDir, limit: 10, avgTaskSeconds: 300 });
        expect(report.timeRecoveredSeconds).toBeGreaterThan(0);
        expect(report.timeRecoveredFormatted).toBeDefined();
    });
});
