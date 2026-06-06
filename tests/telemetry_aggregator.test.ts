/**
 * Tests: Telemetry Aggregator (v1.0 — RED PHASE)
 *
 * Verifies the Cache Miss Overhead calculation is mathematically precise (+/- 1ms).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TelemetryAggregator } from "../src/core/telemetry_aggregator";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_DIR = "/tmp/b4mal-telemetry-test";
const TEST_DB = `${TEST_DIR}/test.db`;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS task_cache_v2 (
    id            TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    ast_hash      TEXT NOT NULL,
    exit_code     INTEGER NOT NULL,
    stdout        BLOB,
    stderr        BLOB,
    duration_ms   REAL,
    metadata      JSON,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_content_identity ON task_cache_v2 (id, content_hash);
  CREATE INDEX IF NOT EXISTS idx_logical_isolation ON task_cache_v2 (id, ast_hash);
`;

function insertRow(
    db: Database,
    id: string,
    contentHash: string,
    durationMs: number,
    hitType: "MISS" | "CONTENT_HIT" | "LOGICAL_HIT",
    ioWaitMs: number = 0,
    taxRecoveredMs: number = 0,
    maxRssKb: number = 1024
): void {
    const metadata = JSON.stringify({
        telemetry: {
            cpu_user_ms: durationMs * 0.8,
            cpu_system_ms: durationMs * 0.2,
            max_rss_kb: maxRssKb,
            io_wait_ms: ioWaitMs,
        },
        isolation: {
            hit_type: hitType,
            tax_recovered_ms: taxRecoveredMs,
            is_flaky_candidate: false,
        },
        context: {
            is_agent_originated: false,
        },
    });

    db.query(
        `INSERT INTO task_cache_v2 (id, content_hash, ast_hash, exit_code, duration_ms, metadata)
         VALUES (?, ?, ?, 0, ?, ?)`
    ).run(id, contentHash, `ast_${contentHash}`, durationMs, metadata);
}

describe("TelemetryAggregator", () => {
    let db: Database;

    beforeEach(() => {
        if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
        mkdirSync(TEST_DIR, { recursive: true });
        db = new Database(TEST_DB, { create: true });
        db.exec("PRAGMA journal_mode=WAL;");
        db.exec(SCHEMA_SQL);
    });

    afterEach(() => {
        db.close();
        if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    });

    // ─── Tax Recovered Calculation ────────────────────────────────────────

    test("zero rows returns zero tax", () => {
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalMsSaved).toBe(0);
        expect(result.logicalHits).toBe(0);
        expect(result.efficiencyRatio).toBe(0);
    });

    test("single logical hit returns exact tax", () => {
        insertRow(db, "task-1", "hash1", 500, "LOGICAL_HIT", 2, 498);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalMsSaved).toBe(498);
        expect(result.logicalHits).toBe(1);
    });

    test("multiple logical hits sum correctly", () => {
        insertRow(db, "task-1", "hash1", 500, "LOGICAL_HIT", 2, 498);
        insertRow(db, "task-2", "hash2", 300, "LOGICAL_HIT", 1, 299);
        insertRow(db, "task-3", "hash3", 200, "LOGICAL_HIT", 3, 197);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalMsSaved).toBe(498 + 299 + 197);
        expect(result.logicalHits).toBe(3);
    });

    test("content hits are excluded from tax recovery", () => {
        insertRow(db, "task-1", "hash1", 500, "CONTENT_HIT", 0, 0);
        insertRow(db, "task-2", "hash2", 300, "LOGICAL_HIT", 1, 299);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalMsSaved).toBe(299);
        expect(result.logicalHits).toBe(1);
    });

    test("misses are excluded from tax recovery", () => {
        insertRow(db, "task-1", "hash1", 500, "MISS", 10, 0);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalMsSaved).toBe(0);
        expect(result.logicalHits).toBe(0);
    });

    test("precision: total within +/- 1ms of expected", () => {
        // 10 logical hits with known tax values
        for (let i = 0; i < 10; i++) {
            const duration = 100 + i * 10; // 100, 110, 120...190
            const tax = duration - 2; // 2ms overhead each
            insertRow(db, `task-${i}`, `hash-${i}`, duration, "LOGICAL_HIT", 2, tax);
        }
        // Expected: sum of (98 + 108 + 118 + ... + 188) = 10 * 98 + 10*10*9/2 = 980 + 450 = 1430
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(Math.abs(result.totalMsSaved - 1430)).toBeLessThanOrEqual(1);
    });

    // ─── Efficiency Ratio ─────────────────────────────────────────────────

    test("efficiency ratio is saved/total_duration", () => {
        insertRow(db, "task-1", "hash1", 1000, "LOGICAL_HIT", 10, 990);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.efficiencyRatio).toBeCloseTo(990 / 1000, 2);
    });

    // ─── I/O Jitter Tracking ──────────────────────────────────────────────

    test("total I/O jitter aggregated across all jobs", () => {
        insertRow(db, "task-1", "hash1", 500, "LOGICAL_HIT", 12, 488);
        insertRow(db, "task-2", "hash2", 300, "MISS", 8, 0);
        insertRow(db, "task-3", "hash3", 200, "CONTENT_HIT", 3, 0);
        const result = TelemetryAggregator.calculateTaxSaved(db);
        expect(result.totalJitterMs).toBe(12 + 8 + 3);
    });

    // ─── Critical Path ────────────────────────────────────────────────────

    test("identifies slowest task as critical path bottleneck", () => {
        insertRow(db, "build", "h1", 2000, "MISS", 50, 0);
        insertRow(db, "lint", "h2", 100, "CONTENT_HIT", 1, 0);
        insertRow(db, "test", "h3", 800, "LOGICAL_HIT", 5, 795);
        const bottleneck = TelemetryAggregator.findBottleneck(db);
        expect(bottleneck.id).toBe("build");
        expect(bottleneck.durationMs).toBe(2000);
    });

    // ─── Job History ──────────────────────────────────────────────────────

    test("job count reflects total entries", () => {
        insertRow(db, "a", "h1", 100, "MISS", 0, 0);
        insertRow(db, "b", "h2", 200, "CONTENT_HIT", 0, 0);
        insertRow(db, "c", "h3", 300, "LOGICAL_HIT", 0, 300);
        const stats = TelemetryAggregator.getStats(db);
        expect(stats.totalJobs).toBe(3);
        expect(stats.contentHits).toBe(1);
        expect(stats.logicalHits).toBe(1);
        expect(stats.misses).toBe(1);
    });
});
