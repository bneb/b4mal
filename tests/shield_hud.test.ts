/**
 * Tests: Core Shield HUD (v2.5.0 — RED PHASE)
 *
 * Validates proof tree rendering, failure state visualization,
 * wave-level summaries, and rendering performance.
 */
import { describe, test, expect } from "bun:test";
import {
    ShieldHUD,
    type ProofNode,
    type ShieldRenderResult,
    type WaveShieldResult,
} from "../src/reporter/shield_hud";
import type { IsolationAttestation } from "../src/core/attestation_schema";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAttestation(overrides: Partial<IsolationAttestation> = {}): IsolationAttestation {
    return {
        verified_at: new Date().toISOString(),
        solver: {
            engine: "PREFIX_TREE",
            version: "1.0.0",
            duration_ms: 1.2,
            result: "UNSAT",
            ...overrides.solver,
        },
        proof: {
            isolation_level: "FORMAL",
            logic_hash: "abc123",
            resource_set_hash: "def456",
            ...overrides.proof,
        },
    };
}

function makeSatAttestation(): IsolationAttestation {
    return makeAttestation({
        solver: { engine: "PREFIX_TREE", version: "1.0.0", duration_ms: 0.8, result: "SAT" },
        proof: { isolation_level: "NONE", logic_hash: "abc123", resource_set_hash: "def456" },
    });
}

// ─── Proof Tree Rendering ─────────────────────────────────────────────────────

describe("ShieldHUD", () => {
    test("renders verified proof with constraint tree", () => {
        const constraints: ProofNode[] = [
            { id: "dist/bundle.js", type: "file", verified: true },
            { id: "config.json", type: "file", verified: true },
            { id: "env:NODE_ENV", type: "env", verified: true },
        ];

        const result = ShieldHUD.renderProof("build", makeAttestation(), constraints);

        expect(result.lines.length).toBeGreaterThan(0);
        expect(result.status).toBe("VERIFIED");
        // Must contain each constraint
        expect(result.raw).toContain("dist/bundle.js");
        expect(result.raw).toContain("config.json");
        expect(result.raw).toContain("env:NODE_ENV");
    });

    test("renders ANSI tree structure characters", () => {
        const constraints: ProofNode[] = [
            { id: "src/main.ts", type: "file", verified: true },
        ];

        const result = ShieldHUD.renderProof("test", makeAttestation(), constraints);

        // Must use tree drawing characters
        expect(result.raw).toContain("├");
        expect(result.raw).toContain("└");
    });

    test("includes solver duration in output", () => {
        const att = makeAttestation({ solver: { engine: "PREFIX_TREE", version: "1.0.0", duration_ms: 2.5, result: "UNSAT" } });
        const result = ShieldHUD.renderProof("lint", att, []);

        expect(result.raw).toContain("2.5");
    });

    // ─── Failure State ────────────────────────────────────────────────────

    test("renders collision warning for SAT result", () => {
        const constraints: ProofNode[] = [
            { id: "shared/config.json", type: "file", verified: false },
        ];

        const result = ShieldHUD.renderProof("deploy", makeSatAttestation(), constraints);

        expect(result.status).toBe("COLLISION");
        expect(result.raw).toContain("shared/config.json");
    });

    test("collision output highlights unverified constraints", () => {
        const constraints: ProofNode[] = [
            { id: "a.ts", type: "file", verified: true },
            { id: "shared.ts", type: "file", verified: false },
            { id: "env:API_KEY", type: "env", verified: false },
        ];

        const result = ShieldHUD.renderProof("api", makeSatAttestation(), constraints);

        expect(result.status).toBe("COLLISION");
        expect(result.unverifiedCount).toBe(2);
    });

    // ─── Wave-Level Shield ────────────────────────────────────────────────

    test("renderWave aggregates multiple task proofs", () => {
        const tasks = [
            {
                taskId: "build",
                attestation: makeAttestation(),
                constraints: [{ id: "dist/out.js", type: "file" as const, verified: true }],
            },
            {
                taskId: "lint",
                attestation: makeAttestation(),
                constraints: [{ id: "src/app.ts", type: "file" as const, verified: true }],
            },
        ];

        const result = ShieldHUD.renderWave(1, tasks);

        expect(result.waveIndex).toBe(1);
        expect(result.totalTasks).toBe(2);
        expect(result.allVerified).toBe(true);
        expect(result.raw).toContain("WAVE 1");
    });

    test("renderWave detects mixed verified/collision state", () => {
        const tasks = [
            {
                taskId: "safe",
                attestation: makeAttestation(),
                constraints: [{ id: "a.ts", type: "file" as const, verified: true }],
            },
            {
                taskId: "unsafe",
                attestation: makeSatAttestation(),
                constraints: [{ id: "shared.ts", type: "file" as const, verified: false }],
            },
        ];

        const result = ShieldHUD.renderWave(2, tasks);

        expect(result.allVerified).toBe(false);
        expect(result.totalTasks).toBe(2);
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("proof rendering adds <2ms overhead", () => {
        const constraints: ProofNode[] = Array.from({ length: 20 }, (_, i) => ({
            id: `resource_${i}.ts`,
            type: "file" as const,
            verified: true,
        }));

        const start = performance.now();
        ShieldHUD.renderProof("perf-test", makeAttestation(), constraints);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(2);
    });

    test("wave rendering with 10 tasks completes in <5ms", () => {
        const tasks = Array.from({ length: 10 }, (_, i) => ({
            taskId: `task_${i}`,
            attestation: makeAttestation(),
            constraints: [
                { id: `file_${i}.ts`, type: "file" as const, verified: true },
                { id: `env:VAR_${i}`, type: "env" as const, verified: true },
            ],
        }));

        const start = performance.now();
        ShieldHUD.renderWave(0, tasks);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(5);
    });
});
