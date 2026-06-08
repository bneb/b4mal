// Tests: Rust Shim Integrity (v1.3.0 — RED PHASE)
//
// Validates the engine-side attest handler that receives
// resource claims from the Rust shim via CLI IPC.

import { describe, test, expect } from "bun:test";
import {
    AttestHandler,
    type AttestArgs,
    type AttestResult,
} from "../src/cli/attest";

// ─── CLI Hook: Argument Parsing ──────────────────────────────────────────────

describe("AttestHandler - CLI Hook", () => {
    test("parses task name and resource args", () => {
        const args: AttestArgs = AttestHandler.parseArgs([
            "test_quic_handshake",
            "fs:certs/",
            "env:QUIC_PORT",
            "port:4433",
        ]);

        expect(args.taskName).toBe("test_quic_handshake");
        expect(args.reads).toContain("certs/");
        expect(args.envReads).toContain("QUIC_PORT");
        expect(args.ports).toContain("4433");
    });

    test("parses fs:read and fs:write prefixes", () => {
        const args = AttestHandler.parseArgs([
            "test_storage",
            "fs:read:data/input.json",
            "fs:write:data/output.json",
            "fs:config.toml",
        ]);

        expect(args.reads).toContain("data/input.json");
        expect(args.reads).toContain("config.toml"); // bare fs: defaults to read
        expect(args.writes).toContain("data/output.json");
    });

    test("parses env:read and env:write prefixes", () => {
        const args = AttestHandler.parseArgs([
            "test_env",
            "env:DATABASE_URL",
            "env:write:LOG_LEVEL",
        ]);

        expect(args.envReads).toContain("DATABASE_URL");
        expect(args.envWrites).toContain("LOG_LEVEL");
    });

    test("handles empty resource list", () => {
        const args = AttestHandler.parseArgs(["test_bare"]);

        expect(args.taskName).toBe("test_bare");
        expect(args.reads).toEqual([]);
        expect(args.writes).toEqual([]);
        expect(args.envReads).toEqual([]);
        expect(args.envWrites).toEqual([]);
        expect(args.ports).toEqual([]);
    });
});

// ─── Environment Propagation ─────────────────────────────────────────────────

describe("AttestHandler - Env Propagation", () => {
    test("identifies B4MAL_CALLER header", () => {
        const caller = AttestHandler.identifyCaller({
            B4MAL_CALLER: "rust-shim-v1.3.0",
        });

        expect(caller.name).toBe("rust-shim");
        expect(caller.version).toBe("v1.3.0");
    });

    test("handles missing B4MAL_CALLER gracefully", () => {
        const caller = AttestHandler.identifyCaller({});

        expect(caller.name).toBe("unknown");
        expect(caller.version).toBe("unknown");
    });

    test("parses other shim versions", () => {
        const caller = AttestHandler.identifyCaller({
            B4MAL_CALLER: "go-shim-v2.0.0",
        });

        expect(caller.name).toBe("go-shim");
        expect(caller.version).toBe("v2.0.0");
    });
});

// ─── Silent Failure (Graceful Degradation) ───────────────────────────────────

describe("AttestHandler - Silent Failure", () => {
    test("execute returns success even with no engine state", async () => {
        const result = await AttestHandler.execute(
            ["test_isolated", "fs:tmp/scratch"],
            { B4MAL_CALLER: "rust-shim-v1.3.0" }
        );

        expect(result.accepted).toBe(true);
        expect(result.taskName).toBe("test_isolated");
    });

    test("malformed args return a graceful error, not a crash", async () => {
        const result = await AttestHandler.execute([], {});

        expect(result.accepted).toBe(false);
        expect(result.error).toContain("task name");
    });
});

// ─── FormalShadow Integration ────────────────────────────────────

describe("AttestHandler - FormalShadow Linkage", () => {
    test("converts parsed args to TaskResourceClaim", () => {
        const args = AttestHandler.parseArgs([
            "test_db_migration",
            "fs:read:schema.sql",
            "fs:write:migrations/",
            "env:DATABASE_URL",
            "env:write:MIGRATION_LOCK",
            "port:5432",
        ]);

        const claim = AttestHandler.toClaim(args);

        expect(claim.id).toBe("test_db_migration");
        expect(claim.reads).toContain("schema.sql");
        expect(claim.writes).toContain("migrations/");
        expect(claim.writes).toContain("port:5432"); // ports are writes (exclusive)
        expect(claim.envReads).toContain("DATABASE_URL");
        expect(claim.envWrites).toContain("MIGRATION_LOCK");
    });

    test("two non-overlapping claims verify as isolated", async () => {
        const resultA = await AttestHandler.execute(
            ["test_api", "fs:read:api/routes.rs", "env:API_PORT"],
            { B4MAL_CALLER: "rust-shim-v1.3.0" }
        );
        const resultB = await AttestHandler.execute(
            ["test_db", "fs:write:db/data.db", "env:DB_PORT"],
            { B4MAL_CALLER: "rust-shim-v1.3.0" }
        );

        expect(resultA.accepted).toBe(true);
        expect(resultB.accepted).toBe(true);

        // Verify isolation via FormalShadow
        const claimA = AttestHandler.toClaim(AttestHandler.parseArgs(
            ["test_api", "fs:read:api/routes.rs", "env:API_PORT"]
        ));
        const claimB = AttestHandler.toClaim(AttestHandler.parseArgs(
            ["test_db", "fs:write:db/data.db", "env:DB_PORT"]
        ));

        const { FormalShadow } = await import("../src/core/formal_shadow");
        const pairResult = await FormalShadow.verifyPairIsolation(claimA, claimB);

        expect(pairResult.isolated).toBe(true);
    });

    test("overlapping writes are detected as collision", async () => {
        const claimA = AttestHandler.toClaim(AttestHandler.parseArgs(
            ["test_write_a", "fs:write:shared/config.json"]
        ));
        const claimB = AttestHandler.toClaim(AttestHandler.parseArgs(
            ["test_write_b", "fs:write:shared/config.json"]
        ));

        const { FormalShadow } = await import("../src/core/formal_shadow");
        const pairResult = await FormalShadow.verifyPairIsolation(claimA, claimB);

        expect(pairResult.isolated).toBe(false);
        expect(pairResult.conflictingResources).toContain("shared/config.json");
    });
});
