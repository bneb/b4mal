/**
 * Tests: Shadow Collision Detection
 */
import { describe, test, expect } from "bun:test";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";

describe("FormalShadow: Shadowing", () => {
    test("detects sequential shadowing (overwrite)", async () => {
        const taskA: TaskResourceClaim = {
            id: "taskA",
            reads: [],
            writes: ["foo.txt"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "taskB",
            reads: [],
            writes: ["foo.txt"],
            envReads: [],
            envWrites: [],
        };

        const tasks = [taskA, taskB];
        const deps = new Map([
            ["taskB", ["taskA"]]
        ]);

        const shadows = await FormalShadow.detectShadowing(tasks, deps);
        expect(shadows).toHaveLength(1);
        expect(shadows[0].taskA).toBe("taskA");
        expect(shadows[0].taskB).toBe("taskB");
        expect(shadows[0].counterexample).toBe("Deterministic shadow: taskB overwrites taskA at fs:foo.txt");
    });

    test("detects transitive shadowing", async () => {
        const taskA: TaskResourceClaim = {
            id: "taskA",
            reads: [],
            writes: ["dist/"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "taskB",
            reads: [],
            writes: [],
            envReads: [],
            envWrites: [],
        };
        const taskC: TaskResourceClaim = {
            id: "taskC",
            reads: [],
            writes: ["dist/main.js"],
            envReads: [],
            envWrites: [],
        };

        const tasks = [taskA, taskB, taskC];
        const deps = new Map([
            ["taskB", ["taskA"]],
            ["taskC", ["taskB"]]
        ]);

        const shadows = await FormalShadow.detectShadowing(tasks, deps);
        expect(shadows).toHaveLength(1);
        expect(shadows[0].taskA).toBe("taskA");
        expect(shadows[0].taskB).toBe("taskC");
        expect(shadows[0].counterexample).toBe("Deterministic shadow: taskC overwrites taskA at fs:dist/main.js");
    });

    test("no shadow for disjoint writes", async () => {
        const taskA: TaskResourceClaim = {
            id: "taskA",
            reads: [],
            writes: ["a.txt"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "taskB",
            reads: [],
            writes: ["b.txt"],
            envReads: [],
            envWrites: [],
        };

        const tasks = [taskA, taskB];
        const deps = new Map([
            ["taskB", ["taskA"]]
        ]);

        const shadows = await FormalShadow.detectShadowing(tasks, deps);
        expect(shadows).toHaveLength(0);
    });
});
