/**
 * Tests: Technical Appendix Generator (v2.3.0 — RED PHASE)
 *
 * Validates data consistency, token embedding, markdown integrity,
 * and generation performance.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AppendixGenerator, type AppendixInput } from "../src/core/appendix_gen";
import { CoreAudit } from "../src/core/audit";
import { CoreToken } from "../src/core/core_token";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function seedDatabase(db: Database, tasks: Array<{ id: string; durationMs: number; hitType: string; taxMs: number }>) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_cache_v2 (
        id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        ast_hash TEXT,
        exit_code INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )`);

    for (const t of tasks) {
        const metadata = JSON.stringify({
            isolation: {
                hit_type: t.hitType,
                tax_recovered_ms: t.taxMs,
            },
        });
        db.query(
            `INSERT INTO task_cache_v2 (id, content_hash, exit_code, duration_ms, metadata) VALUES (?, ?, 0, ?, ?)`
        ).run(t.id, `hash_${t.id}`, t.durationMs, metadata);
    }
}

describe("AppendixGenerator", () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(":memory:");
        seedDatabase(db, [
            { id: "build", durationMs: 500, hitType: "LOGICAL_HIT", taxMs: 120 },
            { id: "lint", durationMs: 300, hitType: "LOGICAL_HIT", taxMs: 80 },
            { id: "test", durationMs: 800, hitType: "CONTENT_HIT", taxMs: 0 },
            { id: "deploy", durationMs: 200, hitType: "MISS", taxMs: 0 },
        ]);
    });

    afterEach(() => {
        db.close();
    });

    // ─── Data Consistency ─────────────────────────────────────────────────

    test("ms_saved in appendix matches CoreAudit output exactly", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });

        // The appendix must contain the exact cumulative tax value
        expect(appendix.data.taxRecoveredMs).toBe(report.cumulativeTaxMs);
        expect(appendix.data.taxRecoveredMs).toBe(200); // 120 + 80
    });

    test("logical efficiency matches audit report", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });

        expect(appendix.data.logicalEfficiency).toBe(report.logicalEfficiency);
    });

    test("formal verification count defaults to 0 when not provided", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });

        expect(appendix.data.formalVerifiedCount).toBe(0);
    });

    test("includes formal verification count when provided", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
            formalVerifiedCount: 15,
        });

        expect(appendix.data.formalVerifiedCount).toBe(15);
        expect(appendix.markdown).toContain("15");
    });

    // ─── Token Embedding ──────────────────────────────────────────────────

    test("appendix contains a valid signed Core Token", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();
        const signingKey = "core-signing-key-256";

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey,
            orgId: "acme",
        });

        // Extract token from markdown
        expect(appendix.token).toBeDefined();
        expect(appendix.token.split(".")).toHaveLength(3);

        // Verify the embedded token
        const decoded = CoreToken.verify(appendix.token, signingKey);
        expect(decoded.org_id).toBe("acme");
        expect(decoded.savings_ms).toBe(200);
    });

    // ─── Markdown Integrity ───────────────────────────────────────────────

    test("markdown output contains all three moat sections", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });

        expect(appendix.markdown).toContain("# B4MAL TECHNICAL APPENDIX");
        expect(appendix.markdown).toContain("Logic-Aware Hashing");
        expect(appendix.markdown).toContain("Formal Verification");
        expect(appendix.markdown).toContain("Core Token");
    });

    test("markdown contains proper heading hierarchy", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });

        const lines = appendix.markdown.split("\n");
        const h1 = lines.filter(l => l.startsWith("# ") && !l.startsWith("## "));
        const h2 = lines.filter(l => l.startsWith("## "));
        const h3 = lines.filter(l => l.startsWith("### "));

        expect(h1.length).toBe(1);
        expect(h2.length).toBeGreaterThanOrEqual(3);
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("generation completes in <100ms", () => {
        const audit = new CoreAudit(db);
        const report = audit.generateReport();

        const start = performance.now();
        AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "acme",
        });
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
    });

    // ─── Edge Cases ───────────────────────────────────────────────────────

    test("handles empty audit report (zero tasks)", () => {
        const emptyDb = new Database(":memory:");
        seedDatabase(emptyDb, []);
        const audit = new CoreAudit(emptyDb);
        const report = audit.generateReport();

        const appendix = AppendixGenerator.generate({
            auditReport: report,
            signingKey: "test-key",
            orgId: "new-org",
        });

        expect(appendix.data.taxRecoveredMs).toBe(0);
        expect(appendix.markdown).toContain("new-org");
        emptyDb.close();
    });
});
