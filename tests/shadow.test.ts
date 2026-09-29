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

// ─── Independent (undeclared) overlap ────────────────────────────────────────
//
// The audit must not be limited to pairs already linked by a dependency chain.
// Two independent tasks declaring the same output never appear in each other's
// transitive dependency set, yet one is guaranteed to overwrite the other: the
// WavePlanner serializes them with a synthesized edge, so the overwrite is
// deterministic but silent. Auditing only declared chains reported "no
// shadowing" for exactly that case.

describe("FormalShadow: Shadowing without a declared dependency", () => {
    const twoWriters = (): TaskResourceClaim[] => [
        { id: "alpha", reads: [], writes: ["out/shared.txt"], envReads: [], envWrites: [] },
        { id: "beta", reads: [], writes: ["out/shared.txt"], envReads: [], envWrites: [] },
    ];

    test("reports two independent tasks declaring the same output", async () => {
        const shadows = await FormalShadow.detectShadowing(twoWriters(), new Map());

        expect(shadows).toHaveLength(1);
        expect(shadows[0].kind).toBe("shadow");
        expect(shadows[0].ordering).toBe("implicit");
        expect([shadows[0].taskA, shadows[0].taskB].sort()).toEqual(["alpha", "beta"]);
        expect(shadows[0].resources).toEqual(["out/shared.txt"]);
        expect(shadows[0].counterexample).toMatch(/no declared dependency/);
    });

    test("classifies a declared overwrite as declared ordering", async () => {
        const tasks: TaskResourceClaim[] = [
            { id: "gen", reads: [], writes: ["out/f.txt"], envReads: [], envWrites: [] },
            { id: "patch", reads: ["out/f.txt"], writes: ["out/f.txt"], envReads: [], envWrites: [] },
        ];
        const shadows = await FormalShadow.detectShadowing(tasks, new Map([["patch", ["gen"]]]));

        expect(shadows).toHaveLength(1);
        expect(shadows[0].ordering).toBe("declared");
        expect(shadows[0].taskA).toBe("gen");
        expect(shadows[0].taskB).toBe("patch");
        expect(shadows[0].counterexample).not.toMatch(/no declared dependency/);
    });

    test("reports an undeclared read-after-write as an implicit dependency", async () => {
        const tasks: TaskResourceClaim[] = [
            { id: "emit", reads: [], writes: ["generated/schema.ts"], envReads: [], envWrites: [] },
            { id: "consume", reads: ["generated/schema.ts"], writes: [], envReads: [], envWrites: [] },
        ];
        const shadows = await FormalShadow.detectShadowing(tasks, new Map());

        expect(shadows).toHaveLength(1);
        expect(shadows[0].kind).toBe("implicit-dependency");
        expect(shadows[0].taskA).toBe("emit");
        expect(shadows[0].taskB).toBe("consume");
    });

    test("does not report a declared producer/consumer pair", async () => {
        const tasks: TaskResourceClaim[] = [
            { id: "emit", reads: [], writes: ["generated/schema.ts"], envReads: [], envWrites: [] },
            { id: "consume", reads: ["generated/schema.ts"], writes: [], envReads: [], envWrites: [] },
        ];
        const shadows = await FormalShadow.detectShadowing(tasks, new Map([["consume", ["emit"]]]));
        expect(shadows).toHaveLength(0);
    });

    test("does not report concurrent readers of the same path", async () => {
        const tasks: TaskResourceClaim[] = [
            { id: "a", reads: ["src"], writes: [], envReads: [], envWrites: [] },
            { id: "b", reads: ["src"], writes: [], envReads: [], envWrites: [] },
        ];
        const shadows = await FormalShadow.detectShadowing(tasks, new Map());
        expect(shadows).toHaveLength(0);
    });

    test("output is deterministic regardless of input order", async () => {
        const forward = await FormalShadow.detectShadowing(twoWriters(), new Map());
        const reversed = await FormalShadow.detectShadowing(twoWriters().reverse(), new Map());

        expect(reversed).toHaveLength(1);
        expect(reversed[0].taskA).toBe(forward[0].taskA);
        expect(reversed[0].taskB).toBe(forward[0].taskB);
    });

    test("reports a directory output masking a nested file output", async () => {
        const tasks: TaskResourceClaim[] = [
            { id: "all", reads: [], writes: ["dist/"], envReads: [], envWrites: [] },
            { id: "one", reads: [], writes: ["dist/main.js"], envReads: [], envWrites: [] },
        ];
        const shadows = await FormalShadow.detectShadowing(tasks, new Map());
        expect(shadows).toHaveLength(1);
        expect(shadows[0].kind).toBe("shadow");
    });
});
