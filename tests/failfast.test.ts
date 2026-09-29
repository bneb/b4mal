/**
 * Tests: Fail-fast scheduling.
 *
 * A failed task must not unblock its dependents. Previously the executor
 * decremented every dependent's in-degree in a `.finally()` handler with no
 * regard for the failing exit code, so a failed `typecheck` still let `build`
 * run and emit `dist/` — a green-looking artifact from a red dependency chain.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DynamicExecutor } from "../src/orchestrator/executor";
import { WavePlanner, type OrchestratorTask } from "../src/orchestrator/planner";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "b4mal-failfast-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const mk = (t: Partial<OrchestratorTask> & { id: string; cmd: string[] }): OrchestratorTask => ({
    claims: [],
    deps: [],
    reads: [],
    writes: [],
    ...t,
});

describe("DynamicExecutor — fail-fast", () => {
    test("skips transitive dependents of a failed task", async () => {
        const tasks = [
            mk({ id: "lint", cmd: ["sh", "-c", "exit 3"] }),
            mk({ id: "test", cmd: ["sh", "-c", "echo TEST-RAN"], deps: ["lint"] }),
            mk({
                id: "build",
                cmd: ["sh", "-c", "mkdir -p dist && echo built > dist/out.js"],
                deps: ["test"],
                writes: ["dist"],
            }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 4 });
        const byId = new Map(results.map(r => [r.taskId, r]));

        expect(byId.get("lint")?.exitCode).toBe(3);
        expect(byId.get("lint")?.skipped).toBeFalsy();

        expect(byId.get("test")?.skipped).toBe(true);
        expect(byId.get("build")?.skipped).toBe(true);

        // The downstream work must genuinely not have happened.
        expect(existsSync(join(root, "dist"))).toBe(false);
        expect(byId.get("test")?.stdout ?? "").not.toMatch(/TEST-RAN/);
    });

    test("still runs tasks that do not depend on the failure", async () => {
        const tasks = [
            mk({ id: "lint", cmd: ["sh", "-c", "exit 1"] }),
            mk({ id: "blocked", cmd: ["sh", "-c", "echo nope"], deps: ["lint"] }),
            mk({ id: "independent", cmd: ["sh", "-c", "echo ran > independent.txt"] }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 4 });
        const byId = new Map(results.map(r => [r.taskId, r]));

        expect(byId.get("blocked")?.skipped).toBe(true);
        expect(byId.get("independent")?.exitCode).toBe(0);
        expect(byId.get("independent")?.skipped).toBeFalsy();
        expect(existsSync(join(root, "independent.txt"))).toBe(true);
    });

    test("reports a result for every task even when skipping", async () => {
        const tasks = [
            mk({ id: "a", cmd: ["sh", "-c", "exit 1"] }),
            mk({ id: "b", cmd: ["echo", "b"], deps: ["a"] }),
            mk({ id: "c", cmd: ["echo", "c"], deps: ["b"] }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 4 });

        expect(results).toHaveLength(3);
        expect(new Set(results.map(r => r.taskId))).toEqual(new Set(["a", "b", "c"]));
    });

    test("a skipped dependent does not itself unblock its own dependents", async () => {
        const tasks = [
            mk({ id: "a", cmd: ["sh", "-c", "exit 9"] }),
            mk({ id: "b", cmd: ["echo", "b"], deps: ["a"] }),
            mk({ id: "c", cmd: ["sh", "-c", "echo C-RAN > c.txt"], deps: ["b"] }),
            mk({ id: "d", cmd: ["sh", "-c", "echo D-RAN > d.txt"], deps: ["c"] }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 4 });
        const byId = new Map(results.map(r => [r.taskId, r]));

        expect(byId.get("c")?.skipped).toBe(true);
        expect(byId.get("d")?.skipped).toBe(true);
        expect(existsSync(join(root, "c.txt"))).toBe(false);
        expect(existsSync(join(root, "d.txt"))).toBe(false);
    });

    test("a fully successful graph is unaffected", async () => {
        const tasks = [
            mk({ id: "a", cmd: ["sh", "-c", "echo a > a.txt"] }),
            mk({ id: "b", cmd: ["sh", "-c", "echo b > b.txt"], deps: ["a"] }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        const results = await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 4 });

        expect(results.every(r => r.exitCode === 0)).toBe(true);
        expect(results.some(r => r.skipped)).toBe(false);
        expect(existsSync(join(root, "b.txt"))).toBe(true);
    });

    test("an empty graph resolves without hanging", async () => {
        const results = await DynamicExecutor.run(WavePlanner.planDAG([]), { projectRoot: root });
        expect(results).toEqual([]);
    });
});

// ─── Declared environment variables reach the task ──────────────────────────

describe("DynamicExecutor — envReads plumbing", () => {
    const VAR = "B4MAL_EXECUTOR_ENV_TEST";
    const original = process.env[VAR];

    afterEach(() => {
        if (original === undefined) delete process.env[VAR];
        else process.env[VAR] = original;
    });

    test("passes variables declared via envReads to the subprocess", async () => {
        process.env[VAR] = "visible";

        const tasks = [
            mk({
                id: "capture",
                cmd: ["sh", "-c", `mkdir -p out && printf '%s' "$${VAR}" > out/env.txt`],
                writes: ["out"],
                envReads: [VAR],
            }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 1 });

        expect(await Bun.file(join(root, "out/env.txt")).text()).toBe("visible");
    });

    test("still strips variables that were not declared", async () => {
        process.env[VAR] = "should-be-blocked";

        const tasks = [
            mk({
                id: "capture",
                cmd: ["sh", "-c", `mkdir -p out && printf 'x%sx' "$${VAR}" > out/env.txt`],
                writes: ["out"],
                // note: VAR deliberately not declared
            }),
        ];

        const dag = WavePlanner.planDAG(tasks);
        await DynamicExecutor.run(dag, { projectRoot: root, concurrency: 1 });

        expect(await Bun.file(join(root, "out/env.txt")).text()).toBe("xx");
    });
});
