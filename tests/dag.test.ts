/**
 * Tests: DAG scheduler
 */
import { describe, test, expect } from "bun:test";
import { buildDag, formatDagPlan } from "../src/dag";
import type { Task } from "../src/schema";

function task(id: string, deps: string[] = []): Task {
    return { id, cmd: ["echo", id], dependencies: deps, env: {}, timeout: 0 };
}

describe("buildDag", () => {
    test("single task with no deps → one wave", () => {
        const dag = buildDag([task("a")]);
        expect(dag.waves.length).toBe(1);
        expect(dag.waves[0].taskIds).toEqual(["a"]);
        expect(dag.depths.get("a")).toBe(0);
    });

    test("parallel tasks → single wave", () => {
        const dag = buildDag([task("a"), task("b"), task("c")]);
        expect(dag.waves.length).toBe(1);
        expect(dag.waves[0].taskIds.sort()).toEqual(["a", "b", "c"]);
    });

    test("linear chain → N waves", () => {
        const dag = buildDag([
            task("a"),
            task("b", ["a"]),
            task("c", ["b"]),
        ]);
        expect(dag.waves.length).toBe(3);
        expect(dag.waves[0].taskIds).toEqual(["a"]);
        expect(dag.waves[1].taskIds).toEqual(["b"]);
        expect(dag.waves[2].taskIds).toEqual(["c"]);
    });

    test("diamond dependency → 3 waves", () => {
        const dag = buildDag([
            task("root"),
            task("left", ["root"]),
            task("right", ["root"]),
            task("join", ["left", "right"]),
        ]);
        expect(dag.waves.length).toBe(3);
        expect(dag.waves[0].taskIds).toEqual(["root"]);
        expect(dag.waves[1].taskIds.sort()).toEqual(["left", "right"]);
        expect(dag.waves[2].taskIds).toEqual(["join"]);
    });

    test("critical path is the longest chain", () => {
        const dag = buildDag([
            task("a"),
            task("b", ["a"]),
            task("c", ["b"]),
            task("d"), // independent shallow task
        ]);
        expect(dag.criticalPath).toEqual(["a", "b", "c"]);
    });

    test("throws on dependency cycle", () => {
        expect(() =>
            buildDag([task("a", ["b"]), task("b", ["a"])])
        ).toThrow(/cycle/i);
    });

    test("throws on missing dependency", () => {
        expect(() => buildDag([task("a", ["ghost"])])).toThrow(/unknown task/i);
    });

    test("throws on duplicate task ID", () => {
        expect(() => buildDag([task("a"), task("a")])).toThrow(/duplicate/i);
    });
});

describe("formatDagPlan", () => {
    test("produces readable output", () => {
        const tasks = [task("a"), task("b", ["a"])];
        const dag = buildDag(tasks);
        const output = formatDagPlan(dag, tasks);
        expect(output).toContain("Wave 0");
        expect(output).toContain("Wave 1");
        expect(output).toContain("Critical path");
    });
});
