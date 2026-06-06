/**
 * Tests: Resource Monitor — Z3 Isolation Prover (v1.5.0 — RED PHASE)
 *
 * Verifies that Z3 can prove task isolation by checking
 * disjointness of read/write resource sets.
 */
import { describe, test, expect } from "bun:test";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";

describe("FormalShadow", () => {
    // ─── Basic Collision Detection ────────────────────────────────────────

    test("detects write-write collision on same file", async () => {
        const taskA: TaskResourceClaim = {
            id: "build",
            reads: [],
            writes: ["dist/bundle.js", "config.json"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "lint",
            reads: [],
            writes: ["config.json"], // Collision: both write config.json
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
        expect(result.isolated).toBe(false);
        expect(result.conflictingResources).toContain("config.json");
    });

    test("detects read-write collision", async () => {
        const taskA: TaskResourceClaim = {
            id: "build",
            reads: ["src/main.ts"],
            writes: ["dist/out.js"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "format",
            reads: [],
            writes: ["src/main.ts"], // Writes to build's read
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
        expect(result.isolated).toBe(false);
        expect(result.conflictingResources).toContain("src/main.ts");
    });

    // ─── Proven Independence ──────────────────────────────────────────────

    test("proves disjoint tasks are isolated", async () => {
        const taskA: TaskResourceClaim = {
            id: "build-fe",
            reads: ["src/frontend/**"],
            writes: ["dist/fe.js"],
            envReads: ["NODE_ENV"],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "build-be",
            reads: ["src/backend/**"],
            writes: ["dist/be.js"],
            envReads: ["NODE_ENV"],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
        expect(result.isolated).toBe(true);
        expect(result.conflictingResources).toHaveLength(0);
    });

    test("read-read overlap is safe (no collision)", async () => {
        const taskA: TaskResourceClaim = {
            id: "test-a",
            reads: ["package.json", "tsconfig.json"],
            writes: ["coverage/a.json"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "test-b",
            reads: ["package.json", "tsconfig.json"], // Same reads — safe
            writes: ["coverage/b.json"],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
        expect(result.isolated).toBe(true);
    });

    // ─── Environment Variable Isolation ───────────────────────────────────
test("detects env write-write collision", async () => {
    const taskA: TaskResourceClaim = {
        id: "migrator1",
        reads: [],
        writes: [],
        envReads: [],
        envWrites: ["DATABASE_URL"], // Both mutate same env var
    };

    const taskB: TaskResourceClaim = {
        id: "migrator2",
        reads: [],
        writes: [],
        envReads: [],
        envWrites: ["DATABASE_URL"], // Both mutate same env var
    };

    const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
    expect(result.isolated).toBe(false);
    expect(result.conflictingResources).toContain("DATABASE_URL");
});
test("detects env read-write collision", async () => {
    const taskA: TaskResourceClaim = {
        id: "reader",
        reads: [],
        writes: [],
        envReads: ["API_KEY"], // Reads what writer writes
        envWrites: [],
    };

    const taskB: TaskResourceClaim = {
        id: "writer",
        reads: [],
        writes: [],
        envReads: [],
        envWrites: ["API_KEY"], // Writes what reader reads
    };

    const result = await FormalShadow.verifyPairIsolation(taskA, taskB);
    expect(result.isolated).toBe(false);
    expect(result.conflictingResources).toContain("API_KEY");
});

    // ─── Wave-Level Verification ──────────────────────────────────────────

    test("verifyWave: all disjoint tasks pass", async () => {
        const wave: TaskResourceClaim[] = [
            { id: "a", reads: ["x"], writes: ["out/a"], envReads: [], envWrites: [] },
            { id: "b", reads: ["y"], writes: ["out/b"], envReads: [], envWrites: [] },
            { id: "c", reads: ["z"], writes: ["out/c"], envReads: [], envWrites: [] },
        ];

        const result = await FormalShadow.verifyWave(wave);
        expect(result.verified).toBe(true);
        expect(result.conflicts).toHaveLength(0);
    });

    test("verifyWave: detects collision in multi-task wave", async () => {
        const wave: TaskResourceClaim[] = [
            { id: "a", reads: [], writes: ["shared.log"], envReads: [], envWrites: [] },
            { id: "b", reads: [], writes: ["other.log"], envReads: [], envWrites: [] },
            { id: "c", reads: [], writes: ["shared.log"], envReads: [], envWrites: [] }, // Collides with "a"
        ];

        const result = await FormalShadow.verifyWave(wave);
        expect(result.verified).toBe(false);
        expect(result.conflicts.length).toBeGreaterThan(0);
        expect(result.conflicts[0].taskA).toBe("a");
        expect(result.conflicts[0].taskB).toBe("c");
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("verifies a 10-task disjoint wave with zero conflicts", async () => {
        const wave: TaskResourceClaim[] = [];
        for (let i = 0; i < 10; i++) {
            wave.push({
                id: `task-${i}`,
                reads: [`input-${i}.txt`],
                writes: [`output-${i}.txt`],
                envReads: [],
                envWrites: [],
            });
        }

        const result = await FormalShadow.verifyWave(wave);

        expect(result.verified).toBe(true);
        expect(result.conflicts).toHaveLength(0);
        // All 10 tasks must have been evaluated — C(10,2)=45 pair checks
        expect(result.attestation).toBeDefined();
        expect(result.attestation!.taskIds).toHaveLength(10);
    });

    // ─── Attestation ──────────────────────────────────────────────────────

    test("generates isolation attestation for verified wave", async () => {
        const wave: TaskResourceClaim[] = [
            { id: "a", reads: ["x"], writes: ["out/a"], envReads: [], envWrites: [] },
            { id: "b", reads: ["y"], writes: ["out/b"], envReads: [], envWrites: [] },
        ];

        const result = await FormalShadow.verifyWave(wave);
        expect(result.verified).toBe(true);
        expect(result.attestation).toBeDefined();
        expect(result.attestation!.proofType).toBe("FORMAL_PREFIX_TREE");
        expect(result.attestation!.taskIds).toEqual(["a", "b"]);
        expect(typeof result.attestation!.hash).toBe("string");
        expect(result.attestation!.hash.length).toBeGreaterThan(0);
    });
});
