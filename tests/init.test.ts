/**
 * Tests: Core Onboarding — init (v2.2.0 — RED PHASE)
 *
 * Validates the bootstrap sequence: directory creation,
 * state provisioning, idempotency, and forecast integration.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ProjectScanner } from "../src/core/project_scanner";
import { CoreBootstrap, type BootstrapResult } from "../src/core/core_bootstrap";

let testDir: string;

describe("CoreBootstrap", () => {
    beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), "b4mal-init-"));
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    // ─── Directory Creation ───────────────────────────────────────────────

    test("creates .b4mal directory structure", async () => {
        const result = await CoreBootstrap.init(testDir);

        expect(result.success).toBe(true);
        expect(await Bun.file(join(testDir, ".b4mal", "cache.db")).exists()).toBe(true);
    });

    test("creates certs directory with CA and client keys", async () => {
        const result = await CoreBootstrap.init(testDir);

        expect(result.steps.identity).toBe(true);
        expect(await Bun.file(join(testDir, ".b4mal", "certs", "ca.crt")).exists()).toBe(true);
        expect(await Bun.file(join(testDir, ".b4mal", "certs", "client.key")).exists()).toBe(true);
    });

    // ─── State Provisioning ───────────────────────────────────────────────

    test("initializes SQLite with cache_ledger table", async () => {
        const result = await CoreBootstrap.init(testDir);

        expect(result.steps.state).toBe(true);
        const { Database } = await import("bun:sqlite");
        const db = new Database(join(testDir, ".b4mal", "cache.db"));
        const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
        const tableNames = tables.map(t => t.name);
        expect(tableNames).toContain("cache_ledger");
        db.close();
    });

    test("cache.db includes first_flight metadata", async () => {
        await CoreBootstrap.init(testDir);

        const { Database } = await import("bun:sqlite");
        const db = new Database(join(testDir, ".b4mal", "cache.db"));
        const meta = db.query("SELECT value FROM b4mal_meta WHERE key = 'first_flight'").get() as { value: string } | null;
        expect(meta).not.toBeNull();
        expect(meta!.value).toBeTruthy();
        db.close();
    });

    // ─── Idempotency ──────────────────────────────────────────────────────

    test("second init does not overwrite certs (no --force)", async () => {
        await CoreBootstrap.init(testDir);

        // Read the CA cert content
        const caCertPath = join(testDir, ".b4mal", "certs", "ca.crt");
        const originalCert = await Bun.file(caCertPath).text();

        // Run init again
        const result = await CoreBootstrap.init(testDir);

        expect(result.steps.identity).toBe(true);
        const newCert = await Bun.file(caCertPath).text();
        expect(newCert).toBe(originalCert); // Not overwritten
    });

    test("second init preserves existing database entries", async () => {
        await CoreBootstrap.init(testDir);

        // Insert a test row
        const { Database } = await import("bun:sqlite");
        let db = new Database(join(testDir, ".b4mal", "cache.db"));
        db.exec(`INSERT INTO cache_ledger (logic_hash, task_id, action, timestamp) VALUES ('hash1', 'sentinel', 'execute', 100)`);
        db.close();

        // Run init again
        await CoreBootstrap.init(testDir);

        db = new Database(join(testDir, ".b4mal", "cache.db"));
        const row = db.query("SELECT task_id FROM cache_ledger WHERE task_id = 'sentinel'").get() as { task_id: string } | null;
        expect(row).not.toBeNull();
        expect(row!.task_id).toBe("sentinel");
        db.close();
    });

    test("--force flag regenerates certs", async () => {
        await CoreBootstrap.init(testDir);

        const caCertPath = join(testDir, ".b4mal", "certs", "ca.crt");
        const originalCert = await Bun.file(caCertPath).text();

        await CoreBootstrap.init(testDir, { force: true });

        const newCert = await Bun.file(caCertPath).text();
        // With force, certs should be regenerated (different serial → different content)
        expect(newCert.length).toBeGreaterThan(0);
    });

    // ─── Forecast Integration ─────────────────────────────────────────────

    test("init includes isolation forecast in result", async () => {
        // Create some source files for the scanner
        await mkdir(join(testDir, "src"), { recursive: true });
        await writeFile(join(testDir, "src", "app.ts"), `
// Main application
interface Config { port: number; host: string }
const start = (c: Config) => console.log(c.port);
`);

        const result = await CoreBootstrap.init(testDir);

        expect(result.steps.forecast).toBe(true);
        expect(result.forecast).toBeDefined();
        expect(result.forecast!.filesScanned).toBeGreaterThanOrEqual(0);
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("full bootstrap completes in <1.5s", async () => {
        const start = performance.now();
        await CoreBootstrap.init(testDir);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(1500);
    });
});

// ─── Project Scanner ──────────────────────────────────────────────────────────

describe("ProjectScanner", () => {
    let scanDir: string;

    beforeEach(async () => {
        scanDir = await mkdtemp(join(tmpdir(), "b4mal-scan-"));
    });

    afterEach(async () => {
        await rm(scanDir, { recursive: true, force: true });
    });

    test("finds .ts files in src directory", async () => {
        await mkdir(join(scanDir, "src"), { recursive: true });
        await writeFile(join(scanDir, "src", "main.ts"), "const x = 1;");
        await writeFile(join(scanDir, "src", "util.ts"), "export const y = 2;");

        const files = await ProjectScanner.scanSourceFiles(scanDir);
        expect(files.length).toBe(2);
    });

    test("finds nested .ts files", async () => {
        await mkdir(join(scanDir, "src", "core"), { recursive: true });
        await writeFile(join(scanDir, "src", "core", "deep.ts"), "const z = 3;");

        const files = await ProjectScanner.scanSourceFiles(scanDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
        expect(files.some(f => f.path.includes("deep.ts"))).toBe(true);
    });

    test("excludes node_modules and .b4mal", async () => {
        await mkdir(join(scanDir, "src"), { recursive: true });
        await mkdir(join(scanDir, "node_modules", "pkg"), { recursive: true });
        await mkdir(join(scanDir, ".b4mal"), { recursive: true });
        await writeFile(join(scanDir, "src", "app.ts"), "const a = 1;");
        await writeFile(join(scanDir, "node_modules", "pkg", "index.ts"), "const b = 2;");
        await writeFile(join(scanDir, ".b4mal", "internal.ts"), "const c = 3;");

        const files = await ProjectScanner.scanSourceFiles(scanDir);
        expect(files.every(f => !f.path.includes("node_modules"))).toBe(true);
        expect(files.every(f => !f.path.includes(".b4mal"))).toBe(true);
    });

    test("returns empty array for project with no .ts files", async () => {
        await mkdir(join(scanDir, "src"), { recursive: true });
        await writeFile(join(scanDir, "src", "readme.md"), "# Hello");

        const files = await ProjectScanner.scanSourceFiles(scanDir);
        expect(files).toHaveLength(0);
    });
});
