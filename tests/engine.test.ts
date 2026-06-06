/**
 * Tests: Engine (end-to-end, v0.5.0)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Engine } from "../src/engine";
import { rmSync, existsSync } from "fs";
import type { Pipeline } from "../src/schema";

const TEST_CACHE_DIR = "/tmp/b4mal-e2e-cache";

function makeEngine(opts = {}) {
    return new Engine({
        cacheDir: TEST_CACHE_DIR,
        silent: true,
        ...opts,
    });
}

afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
        rmSync(TEST_CACHE_DIR, { recursive: true });
    }
});

describe("Engine", () => {
    test("executes single task pipeline", async () => {
        const engine = makeEngine();
        try {
            const pipeline: Pipeline = {
                name: "single",
                tasks: [{ id: "hello", cmd: ["echo", "hi"], env: {}, dependencies: [], timeout: 0 }],
                concurrency: 0,
                env: {},
            };
            const result = await engine.execute(pipeline);
            expect(result.success).toBe(true);
            expect(result.tasks.length).toBe(1);
            expect(result.tasks[0].exitCode).toBe(0);
            expect(result.tasks[0].stdout.trim()).toBe("hi");
        } finally {
            engine.close();
        }
    });

    test("respects dependency order", async () => {
        const engine = makeEngine();
        try {
            const pipeline: Pipeline = {
                name: "ordered",
                tasks: [
                    { id: "first", cmd: ["echo", "1"], env: {}, dependencies: [], timeout: 0 },
                    { id: "second", cmd: ["echo", "2"], env: {}, dependencies: ["first"], timeout: 0 },
                    { id: "third", cmd: ["echo", "3"], env: {}, dependencies: ["second"], timeout: 0 },
                ],
                concurrency: 0,
                env: {},
            };
            const result = await engine.execute(pipeline);
            expect(result.success).toBe(true);
            expect(result.tasks.length).toBe(3);
            const ids = result.tasks.map((t) => t.id);
            expect(ids.indexOf("first")).toBeLessThan(ids.indexOf("second"));
            expect(ids.indexOf("second")).toBeLessThan(ids.indexOf("third"));
        } finally {
            engine.close();
        }
    });

    test("fails fast on task failure", async () => {
        const engine = makeEngine();
        try {
            const pipeline: Pipeline = {
                name: "fail-fast",
                tasks: [
                    { id: "fail", cmd: ["bash", "-c", "exit 1"], env: {}, dependencies: [], timeout: 0 },
                    { id: "never", cmd: ["echo", "should not run"], env: {}, dependencies: ["fail"], timeout: 0 },
                ],
                concurrency: 0,
                env: {},
            };
            const result = await engine.execute(pipeline);
            expect(result.success).toBe(false);
            const neverResult = result.tasks.find((t) => t.id === "never");
            expect(neverResult).toBeUndefined();
        } finally {
            engine.close();
        }
    });

    test("dry run returns empty results", async () => {
        const engine = makeEngine({ dryRun: true });
        try {
            const pipeline: Pipeline = {
                name: "dry",
                tasks: [{ id: "a", cmd: ["echo", "a"], env: {}, dependencies: [], timeout: 0 }],
                concurrency: 0,
                env: {},
            };
            const result = await engine.execute(pipeline);
            expect(result.success).toBe(true);
            expect(result.tasks.length).toBe(0);
        } finally {
            engine.close();
        }
    });

    test("cache hit on repeat execution", async () => {
        const pipeline: Pipeline = {
            name: "cached",
            tasks: [{ id: "echo", cmd: ["echo", "cached"], env: {}, dependencies: [], timeout: 0 }],
            concurrency: 0,
            env: {},
        };

        // First run
        const engine1 = makeEngine();
        try {
            const r1 = await engine1.execute(pipeline);
            expect(r1.success).toBe(true);
            expect(r1.tasks[0].cacheHit).toBe(false);
        } finally {
            engine1.close();
        }

        // Second run — should hit cache
        const engine2 = makeEngine();
        try {
            const r2 = await engine2.execute(pipeline);
            expect(r2.success).toBe(true);
            expect(r2.tasks[0].cacheHit).toBe("content");
        } finally {
            engine2.close();
        }
    });

    test("no-cache bypasses cache", async () => {
        const pipeline: Pipeline = {
            name: "no-cache",
            tasks: [{ id: "echo", cmd: ["echo", "fresh"], env: {}, dependencies: [], timeout: 0 }],
            concurrency: 0,
            env: {},
        };

        const engine1 = makeEngine();
        try {
            await engine1.execute(pipeline);
        } finally {
            engine1.close();
        }

        const engine2 = makeEngine({ noCache: true });
        try {
            const r2 = await engine2.execute(pipeline);
            expect(r2.tasks[0].cacheHit).toBe(false);
        } finally {
            engine2.close();
        }
    });

    test("parallel tasks execute concurrently", async () => {
        const engine = makeEngine();
        try {
            const tasks = Array.from({ length: 10 }, (_, i) => ({
                id: `p-${i}`,
                cmd: ["sleep", "0.05"],
                env: {},
                dependencies: [] as string[],
                timeout: 0,
            }));

            const pipeline: Pipeline = {
                name: "parallel",
                tasks,
                concurrency: 0,
                env: {},
            };

            const result = await engine.execute(pipeline);
            expect(result.success).toBe(true);
            expect(result.tasks.length).toBe(10);
            expect(result.totalDurationMs).toBeLessThan(400);
        } finally {
            engine.close();
        }
    });
});
