/**
 * Tests: Isolation Attestation (v1.5.0 — RED PHASE)
 *
 * Validates the attestation schema, FormalShadow.attest(),
 * SQLite persistence, and audit-level filtering.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
    IsolationAttestationSchema,
    type IsolationAttestation,
} from "../src/core/attestation_schema";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";

// ─── Schema Validation ───────────────────────────────────────────────────────

describe("IsolationAttestationSchema", () => {
    test("valid attestation parses correctly", () => {
        const raw = {
            verified_at: new Date().toISOString(),
            verifier: {
                engine: "PREFIX_TREE",
                version: "4.16.0",
                duration_ms: 1.5,
                result: "VERIFIED",
            },
            proof: {
                isolation_level: "FORMAL",
                logic_hash: "abc123def456",
                resource_set_hash: "fedcba654321",
            },
        };
        const result = IsolationAttestationSchema.safeParse(raw);
        expect(result.success).toBe(true);
    });

    test("missing verifier.duration_ms throws Zod error", () => {
        const raw = {
            verified_at: new Date().toISOString(),
            verifier: {
                engine: "PREFIX_TREE",
                version: "4.16.0",
                // duration_ms missing!
                result: "VERIFIED",
            },
            proof: {
                isolation_level: "FORMAL",
                logic_hash: "abc",
                resource_set_hash: "def",
            },
        };
        const result = IsolationAttestationSchema.safeParse(raw);
        expect(result.success).toBe(false);
    });

    test("invalid verifier.result enum throws Zod error", () => {
        const raw = {
            verified_at: new Date().toISOString(),
            verifier: {
                engine: "PREFIX_TREE",
                version: "4.16.0",
                duration_ms: 1.0,
                result: "MAYBE", // Invalid
            },
            proof: {
                isolation_level: "FORMAL",
                logic_hash: "abc",
                resource_set_hash: "def",
            },
        };
        const result = IsolationAttestationSchema.safeParse(raw);
        expect(result.success).toBe(false);
    });

    test("signature field is optional", () => {
        const raw = {
            verified_at: new Date().toISOString(),
            verifier: { engine: "PREFIX_TREE", version: "4.16.0", duration_ms: 2.0, result: "VERIFIED" },
            proof: { isolation_level: "FORMAL", logic_hash: "a", resource_set_hash: "b" },
        };
        const withSig = { ...raw, signature: "mTLS_placeholder_sig" };

        expect(IsolationAttestationSchema.safeParse(raw).success).toBe(true);
        expect(IsolationAttestationSchema.safeParse(withSig).success).toBe(true);
    });
});

// ─── FormalShadow.attest() Integration ────────────────────────────────────────

describe("FormalShadow.attest", () => {
    test("generates structured attestation for isolated tasks", async () => {
        const claims: TaskResourceClaim[] = [
            { id: "build", reads: ["src/a.ts"], writes: ["dist/a.js"], envReads: [], envWrites: [] },
            { id: "lint", reads: ["src/b.ts"], writes: ["dist/b.js"], envReads: [], envWrites: [] },
        ];

        const attestation = await FormalShadow.attest(claims, "logic_hash_abc");

        expect(attestation.verifier.engine).toBe("PREFIX_TREE");
        expect(attestation.verifier.result).toBe("VERIFIED");
        expect(attestation.proof.isolation_level).toBe("FORMAL");
        expect(attestation.proof.logic_hash).toBe("logic_hash_abc");
        expect(attestation.proof.resource_set_hash.length).toBeGreaterThan(0);
        expect(attestation.verifier.duration_ms).toBeGreaterThanOrEqual(0);
    });

    test("COLLISION result for colliding tasks", async () => {
        const claims: TaskResourceClaim[] = [
            { id: "a", reads: [], writes: ["shared.log"], envReads: [], envWrites: [] },
            { id: "b", reads: [], writes: ["shared.log"], envReads: [], envWrites: [] },
        ];

        const attestation = await FormalShadow.attest(claims, "hash_x");

        expect(attestation.verifier.result).toBe("COLLISION");
        expect(attestation.proof.isolation_level).toBe("NONE");
    });

    test("attestation validates against Zod schema", async () => {
        const claims: TaskResourceClaim[] = [
            { id: "a", reads: ["x"], writes: ["y"], envReads: [], envWrites: [] },
        ];

        const attestation = await FormalShadow.attest(claims, "hash_z");
        const result = IsolationAttestationSchema.safeParse(attestation);
        expect(result.success).toBe(true);
    });
});

// ─── SQLite Persistence ───────────────────────────────────────────────────────

describe("Attestation Persistence", () => {
    test("attestation round-trips through SQLite metadata column", async () => {
        const db = new Database(":memory:");
        db.exec(`CREATE TABLE task_cache_v2 (
            id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            ast_hash TEXT,
            exit_code INTEGER NOT NULL,
            duration_ms REAL NOT NULL,
            metadata TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`);

        const claims: TaskResourceClaim[] = [
            { id: "build", reads: ["src/a.ts"], writes: ["dist/a.js"], envReads: [], envWrites: [] },
        ];
        const attestation = await FormalShadow.attest(claims, "logic_abc");

        // Store with attestation in metadata
        const metadata = JSON.stringify({
            isolation: { hit_type: "MISS", tax_recovered_ms: 0 },
            attestation,
        });

        db.query(
            `INSERT INTO task_cache_v2 (id, content_hash, ast_hash, exit_code, duration_ms, metadata)
             VALUES ('build', 'ch1', 'ah1', 0, 100, ?)`
        ).run(metadata);

        // Read back
        const row = db.query(
            `SELECT json_extract(metadata, '$.attestation.verifier.result') as result,
                    json_extract(metadata, '$.attestation.proof.isolation_level') as level
             FROM task_cache_v2 WHERE id = 'build'`
        ).get() as { result: string; level: string };

        expect(row.result).toBe("VERIFIED");
        expect(row.level).toBe("FORMAL");

        db.close();
    });

    test("audit can count FORMAL attestations", async () => {
        const db = new Database(":memory:");
        db.exec(`CREATE TABLE task_cache_v2 (
            id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            ast_hash TEXT,
            exit_code INTEGER NOT NULL,
            duration_ms REAL NOT NULL,
            metadata TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`);

        // 3 tasks: 2 FORMAL, 1 NONE
        const formalMeta = JSON.stringify({
            attestation: { verifier: { result: "VERIFIED" }, proof: { isolation_level: "FORMAL" } },
        });
        const noneMeta = JSON.stringify({
            attestation: { verifier: { result: "COLLISION" }, proof: { isolation_level: "NONE" } },
        });

        db.query(`INSERT INTO task_cache_v2 (id, content_hash, exit_code, duration_ms, metadata) VALUES ('a', 'c1', 0, 50, ?)`).run(formalMeta);
        db.query(`INSERT INTO task_cache_v2 (id, content_hash, exit_code, duration_ms, metadata) VALUES ('b', 'c2', 0, 60, ?)`).run(formalMeta);
        db.query(`INSERT INTO task_cache_v2 (id, content_hash, exit_code, duration_ms, metadata) VALUES ('c', 'c3', 0, 70, ?)`).run(noneMeta);

        const row = db.query(
            `SELECT COUNT(*) as formal_count FROM task_cache_v2
             WHERE json_valid(metadata) AND json_extract(metadata, '$.attestation.proof.isolation_level') = 'FORMAL'`
        ).get() as { formal_count: number };

        expect(row.formal_count).toBe(2);

        db.close();
    });
});
