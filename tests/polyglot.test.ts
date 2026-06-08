// Tests: Polyglot Verification Suite (v1.4.0 — RED PHASE)
//
// Demonstrates a "Resource War" between Rust, Python, and TypeScript.
// Verifies that the b4mal engine (FormalShadow) correctly merges
// attestations from all 3 runtimes and detects collisions.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { AttestHandler } from "../src/cli/attest";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";

// ─── Shim Execution Helpers ──────────────────────────────────────────────────

// We simulate the shim executions by directly calling the AttestHandler
// with the exact environment variables the shims would inject.

async function simRust(taskName: string, args: string[]) {
    return AttestHandler.execute([taskName, ...args], {
        B4MAL_CALLER: "rust-shim-v1.3.0",
    });
}

async function simPython(taskName: string, args: string[]) {
    return AttestHandler.execute([taskName, ...args], {
        B4MAL_CALLER: "python-shim-v1.4.0",
    });
}

async function simTypeScript(taskName: string, args: string[]) {
    return AttestHandler.execute([taskName, ...args], {
        B4MAL_CALLER: "ts-shim-v1.4.0",
    });
}

// ─── Inter-Process Fidelity ──────────────────────────────────────────────────

describe("Polyglot - Inter-Process Fidelity", () => {
    test("engine correctly identifies callers from different runtimes", async () => {
        const rustRes = await simRust("BinaryCompiler", ["fs:write:dist/app.bin", "env:LICENSE_KEY"]);
        const pyRes = await simPython("DataProcessor", ["fs:write:db/local.sqlite", "fs:dist/app.bin"]);
        const tsRes = await simTypeScript("WebIntegrator", ["fs:write:db/local.sqlite", "env:PORT"]);

        expect(rustRes.caller?.name).toBe("rust-shim");
        expect(pyRes.caller?.name).toBe("python-shim");
        expect(tsRes.caller?.name).toBe("ts-shim");

        expect(rustRes.claim?.writes).toContain("dist/app.bin");
        expect(pyRes.claim?.reads).toContain("dist/app.bin");
        expect(tsRes.claim?.writes).toContain("db/local.sqlite");
    });

    test("Sequential Dependency (Write -> Read) is isolated", async () => {
        // Run in a single wave (which we shouldn't do for dependencies, but testing engine behavior)
        // If they run concurrently, W -> R is a collision.

        const claimRust = AttestHandler.toClaim(AttestHandler.parseArgs(["BinaryCompiler", "fs:write:dist/app.bin"]));
        const claimPy = AttestHandler.toClaim(AttestHandler.parseArgs(["DataProcessor", "fs:read:dist/app.bin"]));

        const pairResult = await FormalShadow.verifyPairIsolation(claimRust, claimPy);

        // Write + Read on the same resource during the SAME wave is a collision
        expect(pairResult.isolated).toBe(false);
        expect(pairResult.conflictingResources).toContain("dist/app.bin");
    });
});

// ─── Collision Detection ──────────────────────────────────────────────────

describe("Polyglot - Collision Detection", () => {
    test("detects Write-Write collision on SQLite DB (Python vs TS)", async () => {
        const claimPy = AttestHandler.toClaim(AttestHandler.parseArgs([
            "DataProcessor",
            "fs:write:db/local.sqlite"
        ]));

        const claimTs = AttestHandler.toClaim(AttestHandler.parseArgs([
            "WebIntegrator",
            "fs:write:db/local.sqlite",
            "port:3000"
        ]));

        const pairResult = await FormalShadow.verifyPairIsolation(claimPy, claimTs);

        expect(pairResult.isolated).toBe(false);
        expect(pairResult.conflictingResources).toContain("db/local.sqlite");
    });

    test("Wave Verification flags the polyglot collision and rejects attestation", async () => {
        const wave = [
            AttestHandler.toClaim(AttestHandler.parseArgs([
                "BinaryCompiler", "fs:write:dist/app.bin", "env:LICENSE_KEY"
            ])),
            AttestHandler.toClaim(AttestHandler.parseArgs([
                "DataProcessor", "fs:write:db/local.sqlite", "fs:read:dist/app.bin"
            ])),
            AttestHandler.toClaim(AttestHandler.parseArgs([
                "WebIntegrator", "fs:write:db/local.sqlite", "env:PORT"
            ])),
        ];

        const result = await FormalShadow.verifyWave(wave);

        expect(result.verified).toBe(false);
        expect(result.attestation).toBeUndefined();

        // Should find two conflicts:
        // 1. Compile vs Process (dist/app.bin)
        // 2. Process vs Web (db/local.sqlite)
        expect(result.conflicts.length).toBe(2);

        const resources = result.conflicts.flatMap(c => c.resources);
        expect(resources).toContain("dist/app.bin");
        expect(resources).toContain("db/local.sqlite");
    });
});

// ─── Graceful Recovery ───────────────────────────────────────────────────────

describe("Polyglot - Graceful Recovery", () => {
    test("engine maintains integrity if Python shim fails (missing logic)", async () => {
        // If the Python shim is invoked with bad args, it shouldn't crash
        // the engine handling the TS/Rust requests.
        const pyRes = await simPython("", []); // Missing task name

        expect(pyRes.accepted).toBe(false);
        expect(pyRes.error).toBeDefined();

        // TS and Rust can still be attested
        const tsRes = await simTypeScript("ValidTask", ["fs:valid"]);
        expect(tsRes.accepted).toBe(true);
    });
});
