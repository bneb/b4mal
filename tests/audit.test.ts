/**
 * Tests: Core Audit (v1.0 — RED PHASE)
 *
 * Verifies 30-day aggregation, temporal integrity, null safety,
 * and the prestige metric calculation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { CoreAudit } from "../src/core/audit";
import { mkdirSync, existsSync, rmSync } from "fs";

const TEST_DIR = "/tmp/b4mal-audit-test";
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
`;

function insertRow(
    db: Database,
    id: string,
    durationMs: number,
    hitType: "MISS" | "CONTENT_HIT" | "LOGICAL_HIT",
    createdAt?: string
): void {
    const metadata = JSON.stringify({
        telemetry: { cpu_user_ms: 0, cpu_system_ms: 0, max_rss_kb: 1024, io_wait_ms: 0 },
        isolation: { hit_type: hitType, tax_recovered_ms: hitType === "LOGICAL_HIT" ? durationMs : 0, is_flaky_candidate: false },
        context: { is_agent_originated: false },
    });
    const ts = createdAt ?? new Date().toISOString();
    db.query(
        `INSERT INTO task_cache_v2 (id, content_hash, ast_hash, exit_code, duration_ms, metadata, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(id, `c_${id}_${Math.random()}`, `a_${id}`, durationMs, metadata, ts);
}

describe("CoreAudit", () => {
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

    // ─── Null Safety ──────────────────────────────────────────────────────

    test("empty database returns safe zeroes", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.totalTasks).toBe(0);
        expect(report.logicalHits).toBe(0);
        expect(report.logicalEfficiency).toBe(0);
        expect(report.cumulativeTaxMs).toBe(0);
        expect(report.estimatedHoursSaved).toBe(0);
    });

    // ─── Aggregation Accuracy ─────────────────────────────────────────────

    test("50/50 content/logic split yields 50% efficacy", () => {
        for (let i = 0; i < 50; i++) {
            insertRow(db, `content-${i}`, 100, "CONTENT_HIT");
        }
        for (let i = 0; i < 50; i++) {
            insertRow(db, `logic-${i}`, 200, "LOGICAL_HIT");
        }
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.totalTasks).toBe(100);
        expect(report.logicalHits).toBe(50);
        expect(report.logicalEfficiency).toBeCloseTo(50.0, 1);
    });

    test("cumulative tax is sum of logical hit durations", () => {
        insertRow(db, "a", 500, "LOGICAL_HIT");
        insertRow(db, "b", 300, "LOGICAL_HIT");
        insertRow(db, "c", 200, "CONTENT_HIT");
        insertRow(db, "d", 100, "MISS");
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.cumulativeTaxMs).toBe(800);
    });

    test("average duration across all tasks", () => {
        insertRow(db, "a", 100, "MISS");
        insertRow(db, "b", 200, "MISS");
        insertRow(db, "c", 300, "MISS");
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.avgDurationMs).toBeCloseTo(200, 0);
    });

    // ─── Temporal Integrity ───────────────────────────────────────────────

    test("only includes last 30 days", () => {
        // Recent: within 30 days
        insertRow(db, "recent", 500, "LOGICAL_HIT");

        // Old: 60 days ago
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
        insertRow(db, "old", 1000, "LOGICAL_HIT", sixtyDaysAgo.toISOString());

        const audit = new CoreAudit(db);
        const report = audit.generateReport(30);
        expect(report.totalTasks).toBe(1);
        expect(report.cumulativeTaxMs).toBe(500);
    });

    test("custom window (7 days)", () => {
        insertRow(db, "today", 100, "LOGICAL_HIT");

        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
        insertRow(db, "ten-days", 200, "LOGICAL_HIT", tenDaysAgo.toISOString());

        const audit = new CoreAudit(db);
        const report = audit.generateReport(7);
        expect(report.totalTasks).toBe(1);
        expect(report.cumulativeTaxMs).toBe(100);
    });

    // ─── Prestige Metric ──────────────────────────────────────────────────

    test("estimated hours saved from logical hits", () => {
        // 3,600,000 ms = 1 hour
        insertRow(db, "big-save", 3600000, "LOGICAL_HIT");
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.estimatedHoursSaved).toBeCloseTo(1.0, 1);
    });

    // ─── Isolation Status ───────────────────────────────────────────────

    test("high isolation when efficacy >= 20%", () => {
        for (let i = 0; i < 30; i++) insertRow(db, `l-${i}`, 100, "LOGICAL_HIT");
        for (let i = 0; i < 70; i++) insertRow(db, `m-${i}`, 100, "MISS");
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.isolationStatus).toBe("HIGH");
    });

    test("low isolation when efficacy < 20%", () => {
        for (let i = 0; i < 10; i++) insertRow(db, `l-${i}`, 100, "LOGICAL_HIT");
        for (let i = 0; i < 90; i++) insertRow(db, `m-${i}`, 100, "MISS");
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        expect(report.isolationStatus).toBe("LOW");
    });

    // ─── Malformed Metadata ───────────────────────────────────────────────

    test("survives malformed metadata JSON", () => {
        db.query(
            `INSERT INTO task_cache_v2 (id, content_hash, ast_hash, exit_code, duration_ms, metadata)
             VALUES ('bad', 'c1', 'a1', 0, 100, 'NOT_JSON')`
        ).run();
        const audit = new CoreAudit(db);
        // Should not throw
        expect(() => audit.generateReport()).not.toThrow();
    });
});
