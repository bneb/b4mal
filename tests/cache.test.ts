/**
 * Tests: SQLite Cache (v0.5.0 — Dual-Key Lookup)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskCache } from "../src/cache";
import { mkdirSync, existsSync, rmSync } from "fs";
import type { Task, TaskResult } from "../src/schema";

const TEST_CACHE_DIR = "/tmp/b4mal-test-cache";
const TEST_DB = `${TEST_CACHE_DIR}/test.db`;

describe("TaskCache", () => {
    let cache: TaskCache;

    beforeEach(() => {
        if (existsSync(TEST_CACHE_DIR)) {
            rmSync(TEST_CACHE_DIR, { recursive: true });
        }
        mkdirSync(TEST_CACHE_DIR, { recursive: true });
        cache = new TaskCache(TEST_DB);
    });

    afterEach(() => {
        cache.close();
        if (existsSync(TEST_CACHE_DIR)) {
            rmSync(TEST_CACHE_DIR, { recursive: true });
        }
    });

    const sampleTask: Task = {
        id: "build",
        cmd: ["npm", "run", "build"],
        env: { NODE_ENV: "production" },
        dependencies: [],
        timeout: 0,
    };

    const sampleResult: TaskResult = {
        id: "build",
        exitCode: 0,
        durationMs: 123.45,
        stdout: "build output",
        stderr: "",
        cacheHit: false,
    };

    // ─── v0.1.0 tests (migrated) ──────────────────────────────────────────

    test("cache miss on empty db", () => {
        const hit = cache.isCached(sampleTask);
        expect(hit).toBeNull();
    });

    test("content cache hit after store", () => {
        cache.store(sampleTask, sampleResult);
        const hit = cache.isCached(sampleTask);
        expect(hit).not.toBeNull();
        expect(hit!.id).toBe("build");
        expect(hit!.exitCode).toBe(0);
        expect(hit!.cacheHit).toBe("content");
    });

    test("cache miss on different cmd", () => {
        cache.store(sampleTask, sampleResult);
        const differentTask: Task = { ...sampleTask, cmd: ["npm", "run", "test"] };
        const hit = cache.isCached(differentTask);
        expect(hit).toBeNull();
    });

    test("cache miss on different env", () => {
        cache.store(sampleTask, sampleResult);
        const differentTask: Task = {
            ...sampleTask,
            env: { NODE_ENV: "development" },
        };
        const hit = cache.isCached(differentTask);
        expect(hit).toBeNull();
    });

    test("does not cache failed tasks", () => {
        const failedResult: TaskResult = { ...sampleResult, exitCode: 1 };
        cache.store(sampleTask, failedResult);
        const hit = cache.isCached(sampleTask);
        expect(hit).toBeNull();
    });

    test("content hash is deterministic", () => {
        const hash1 = cache.hashTask(sampleTask);
        const hash2 = cache.hashTask(sampleTask);
        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(64);
    });

    test("clear removes all entries", () => {
        cache.store(sampleTask, sampleResult);
        cache.clear();
        const hit = cache.isCached(sampleTask);
        expect(hit).toBeNull();
    });

    // ─── v0.5.0 Dual-Key Tests ────────────────────────────────────────────

    test("logic hash fallback: content miss but logic hit", () => {
        const logicHash = "abc123logic";

        // Store with a logic hash
        cache.store(sampleTask, sampleResult, logicHash);

        // Different content (different env) but same logic hash → LOGICAL HIT
        const differentTask: Task = {
            ...sampleTask,
            env: { NODE_ENV: "staging" }, // Different env → different content hash
        };
        const hit = cache.isCached(differentTask, logicHash);
        expect(hit).not.toBeNull();
        expect(hit!.cacheHit).toBe("logic");
    });

    test("content hit takes priority over logic hit", () => {
        const logicHash = "abc123logic";
        cache.store(sampleTask, sampleResult, logicHash);

        // Same task → same content hash → CONTENT HIT (not logic)
        const hit = cache.isCached(sampleTask, logicHash);
        expect(hit).not.toBeNull();
        expect(hit!.cacheHit).toBe("content");
    });

    test("no logic hash provided → no fallback", () => {
        const logicHash = "abc123logic";
        cache.store(sampleTask, sampleResult, logicHash);

        // Different content, no logic hash passed → MISS
        const differentTask: Task = {
            ...sampleTask,
            env: { NODE_ENV: "staging" },
        };
        const hit = cache.isCached(differentTask); // No logicHash arg
        expect(hit).toBeNull();
    });

    test("different logic hash → miss on both keys", () => {
        cache.store(sampleTask, sampleResult, "logicA");

        const differentTask: Task = {
            ...sampleTask,
            env: { NODE_ENV: "staging" },
        };
        const hit = cache.isCached(differentTask, "logicB"); // Different logic hash
        expect(hit).toBeNull();
    });

    test("store and retrieve with ast_hash column", () => {
        const logicHash = "deadbeef1234";
        cache.store(sampleTask, sampleResult, logicHash);

        // Verify content hit still works
        const hit = cache.isCached(sampleTask);
        expect(hit).not.toBeNull();
        expect(hit!.stdout).toBe("build output");
    });
});
