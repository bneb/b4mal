// Tests: Core Orchestrator (v2.4.0 — RED-to-GREEN)
//
// Validates the Wave Planner (resource-claim-aware parallel grouping),
// the Executor (non-blocking wave dispatch), and HUD event emission.

import { describe, test, expect, beforeEach } from "bun:test";
import { WavePlanner, type OrchestratorTask, type Wave } from "../src/orchestrator/planner";
import { DynamicExecutor, type WaveResult } from "../src/orchestrator/executor";
import { StreamEngine } from "../src/server/stream_engine";

// ─── Wave Planner: Disjoint Claim Grouping ───────────────────────────────────

describe("WavePlanner - Disjoint Claims", () => {
    test("tasks with completely disjoint claims are grouped into one wave", () => {
        const tasks: OrchestratorTask[] = [
            { id: "build-rust", cmd: ["cargo", "build"], claims: ["fs:src/", "fs:target/"], deps: [] },
            { id: "lint-ts", cmd: ["bun", "lint"], claims: ["fs:lib/"], deps: [] },
            { id: "test-py", cmd: ["pytest"], claims: ["fs:tests/"], deps: [] },
        ];

        const waves = WavePlanner.plan(tasks);

        // All three have disjoint claims → single wave
        expect(waves.length).toBe(1);
        expect(waves[0].taskIds.length).toBe(3);
    });

    test("tasks with overlapping claims are split into sequential waves", () => {
        const tasks: OrchestratorTask[] = [
            { id: "writer-a", cmd: ["write-db"], claims: ["fs:db/local.sqlite"], deps: [] },
            { id: "writer-b", cmd: ["migrate-db"], claims: ["fs:db/local.sqlite"], deps: [] },
            { id: "reader", cmd: ["read-log"], claims: ["fs:logs/"], deps: [] },
        ];

        const waves = WavePlanner.plan(tasks);

        // writer-a and writer-b collide → cannot be in the same wave
        // reader is disjoint from both → can go with either
        expect(waves.length).toBe(2);

        // Verify no wave has both writers
        for (const wave of waves) {
            const hasA = wave.taskIds.includes("writer-a");
            const hasB = wave.taskIds.includes("writer-b");
            expect(hasA && hasB).toBe(false);
        }
    });

    test("dependency ordering is respected across waves", () => {
        const tasks: OrchestratorTask[] = [
            { id: "compile", cmd: ["cargo", "build"], claims: ["fs:target/"], deps: [] },
            { id: "test", cmd: ["cargo", "test"], claims: ["fs:target/"], deps: ["compile"] },
            { id: "lint", cmd: ["clippy"], claims: ["fs:src/"], deps: [] },
        ];

        const waves = WavePlanner.plan(tasks);

        // compile must be in an earlier wave than test
        const compileWave = waves.findIndex(w => w.taskIds.includes("compile"));
        const testWave = waves.findIndex(w => w.taskIds.includes("test"));

        expect(compileWave).toBeLessThan(testWave);
    });

    test("empty task list produces zero waves", () => {
        const waves = WavePlanner.plan([]);
        expect(waves.length).toBe(0);
    });

    test("single task produces exactly one wave", () => {
        const waves = WavePlanner.plan([
            { id: "solo", cmd: ["echo", "hi"], claims: [], deps: [] }
        ]);
        expect(waves.length).toBe(1);
        expect(waves[0].taskIds).toEqual(["solo"]);
    });

    test("tasks with prefix overlaps are split into sequential waves", () => {
        const tasks: OrchestratorTask[] = [
            { id: "task1", cmd: ["echo", "task1"], claims: ["fs:src/"], deps: [] },
            { id: "task2", cmd: ["echo", "task2"], claims: ["fs:src/main.ts"], deps: [] },
        ];

        const waves = WavePlanner.plan(tasks);

        expect(waves.length).toBe(2);
        expect(waves[0].taskIds).toEqual(["task1"]);
        expect(waves[1].taskIds).toEqual(["task2"]);
    });

    test("tasks with overlapping claims have synthetic dependencies injected into DAG", () => {
        const tasks: OrchestratorTask[] = [
            { id: "writer-a", cmd: ["write-db"], claims: ["fs:db/local.sqlite"], deps: [] },
            { id: "writer-b", cmd: ["migrate-db"], claims: ["fs:db/local.sqlite"], deps: [] },
        ];

        const dag = WavePlanner.planDAG(tasks);

        // One of them must now depend on the other to serialize execution
        const inA = dag.inDegree.get("writer-a") ?? 0;
        const inB = dag.inDegree.get("writer-b") ?? 0;
        
        expect(inA + inB).toBe(1); // One is 0, the other is 1
        
        if (inA === 1) {
            expect(dag.dependents.get("writer-b")).toContain("writer-a");
        } else {
            expect(dag.dependents.get("writer-a")).toContain("writer-b");
        }
    });
});

// ─── Wave Executor ───────────────────────────────────────────────────────────

describe("WaveExecutor - Non-blocking Execution", () => {
    test("executes all waves and returns results with timing", async () => {
        const tasks: OrchestratorTask[] = [
            { id: "echo-a", cmd: ["echo", "alpha"], claims: ["fs:a/"], deps: [] },
            { id: "echo-b", cmd: ["echo", "beta"], claims: ["fs:b/"], deps: [] },
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag);

        expect(results.length).toBe(2);
        expect(results.every(r => r.exitCode === 0)).toBe(true);
        expect(results.every(r => r.durationMs >= 0)).toBe(true);
    });

    test("captures stdout from spawned processes", async () => {
        const tasks: OrchestratorTask[] = [
            { id: "hello", cmd: ["echo", "core"], claims: [], deps: [] },
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag);

        expect(results[0].stdout).toContain("core");
    });

    test("failed tasks report non-zero exit codes", async () => {
        const tasks: OrchestratorTask[] = [
            { id: "fail", cmd: ["false"], claims: [], deps: [] },
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag);

        expect(results[0].exitCode).not.toBe(0);
    });
});



// ─── HUD Integration ─────────────────────────────────────────────────────────

describe("WaveExecutor - HUD Events", () => {
    beforeEach(() => {
        StreamEngine.reset();
    });

    test("wave_complete event is broadcast after each wave finishes", async () => {
        const events: string[] = [];
        const writer = (payload: string) => { events.push(payload); };
        StreamEngine.addWriter(writer);

        const tasks: OrchestratorTask[] = [
            { id: "step-1", cmd: ["echo", "1"], claims: ["fs:a/"], deps: [] },
            { id: "step-2", cmd: ["echo", "2"], claims: ["fs:a/"], deps: ["step-1"] }, // Add explicit dependency to force sequential execution
        ];

        const dag = WavePlanner.planDAG(tasks);
        await DynamicExecutor.run(dag);

        StreamEngine.removeWriter(writer);

        // Two sequential tasks → two wave_complete events (since we fire one per task now)
        const waveEvents = events.filter(e => e.includes("wave_complete"));
        expect(waveEvents.length).toBe(2);
    });
});
