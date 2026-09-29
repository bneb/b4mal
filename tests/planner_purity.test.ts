/**
 * Tests: Planner purity and declared-access preservation.
 *
 * `planDAG` used to write its normalized access view back onto the caller's
 * task objects, folding every `fs:` claim into BOTH reads and writes. Those
 * same objects are handed to the executor, which uses `reads` for the cache key
 * and `writes` for artifact packing — so declared *inputs* were archived as
 * artifacts and excluded from cache keys, meaning an unedited workspace could
 * still hit the cache after a source change.
 */
import { describe, test, expect } from "bun:test";
import { WavePlanner, type OrchestratorTask } from "../src/orchestrator/planner";
import { cacheKeyInputs } from "../src/orchestrator/cache_key";

describe("WavePlanner.planDAG — does not mutate caller tasks", () => {
    test("preserves declared reads, writes and claims", () => {
        const task: OrchestratorTask = {
            id: "typecheck",
            cmd: ["bunx", "tsc", "--noEmit"],
            claims: ["fs:src"],
            deps: [],
            reads: ["src"],
            writes: [],
        };

        WavePlanner.planDAG([task]);

        expect(task.reads).toEqual(["src"]);
        expect(task.writes).toEqual([]);
        expect(task.claims).toEqual(["fs:src"]);
    });

    test("preserves the read/write distinction for a producing task", () => {
        const task: OrchestratorTask = {
            id: "build",
            cmd: ["bun", "build"],
            claims: ["fs:src", "fs:dist"],
            deps: [],
            reads: ["src"],
            writes: ["dist"],
        };

        const dag = WavePlanner.planDAG([task]);
        const planned = dag.tasks.get("build")!;

        expect(planned.reads).toEqual(["src"]);
        expect(planned.writes).toEqual(["dist"]);
        // Inputs must remain cache-key inputs; outputs must not.
        expect(cacheKeyInputs(planned)).toEqual(["src"]);
    });

    test("the DAG still serializes overlapping tasks", () => {
        // Purity must not weaken conflict handling: two tasks writing the same
        // path still end up ordered rather than concurrent.
        const tasks: OrchestratorTask[] = [
            { id: "alpha", cmd: ["echo"], claims: ["fs:out/shared.txt"], deps: [], reads: [], writes: ["out/shared.txt"] },
            { id: "beta", cmd: ["echo"], claims: ["fs:out/shared.txt"], deps: [], reads: [], writes: ["out/shared.txt"] },
        ];

        const dag = WavePlanner.planDAG(tasks);
        expect(dag.waves.length).toBeGreaterThanOrEqual(2);

        // Exactly one of the two must be ordered after the other.
        const alphaBeforeBeta = dag.dependents.get("alpha")?.includes("beta") ?? false;
        const betaBeforeAlpha = dag.dependents.get("beta")?.includes("alpha") ?? false;
        expect(alphaBeforeBeta || betaBeforeAlpha).toBe(true);
    });

    test("does not fold claims into writes for planning purposes", () => {
        // A claim-only task (no declared writes) must not be treated as a
        // producer by the executor, which is what drives artifact packing.
        const tasks: OrchestratorTask[] = [
            { id: "only-claims", cmd: ["echo"], claims: ["fs:src"], deps: [], reads: [], writes: [] },
        ];
        const dag = WavePlanner.planDAG(tasks);
        expect(dag.tasks.get("only-claims")!.writes).toEqual([]);
    });
});
