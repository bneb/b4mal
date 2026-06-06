/**
 * Tests: Task Runner
 */
import { describe, test, expect } from "bun:test";
import { runTask } from "../src/runner";
import type { Task } from "../src/schema";

describe("runTask", () => {
    test("executes echo and captures stdout", async () => {
        const task: Task = {
            id: "echo-test",
            cmd: ["echo", "hello b4mal"],
            env: {},
            dependencies: [],
            timeout: 0,
        };
        const result = await runTask(task);
        expect(result.id).toBe("echo-test");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("hello b4mal");
        expect(result.durationMs).toBeGreaterThan(0);
        expect(result.cacheHit).toBe(false);
    });

    test("captures non-zero exit code", async () => {
        const task: Task = {
            id: "fail-test",
            cmd: ["bash", "-c", "exit 42"],
            env: {},
            dependencies: [],
            timeout: 0,
        };
        const result = await runTask(task);
        expect(result.exitCode).toBe(42);
    });

    test("passes custom env vars", async () => {
        const task: Task = {
            id: "env-test",
            cmd: ["bash", "-c", "echo $B4MAL_TEST_VAR"],
            env: { B4MAL_TEST_VAR: "core" },
            dependencies: [],
            timeout: 0,
        };
        const result = await runTask(task);
        expect(result.stdout.trim()).toBe("core");
    });

    test("merges base env with task env", async () => {
        const task: Task = {
            id: "merge-test",
            cmd: ["bash", "-c", "echo $BASE_VAR-$TASK_VAR"],
            env: { TASK_VAR: "task" },
            dependencies: [],
            timeout: 0,
        };
        const result = await runTask(task, { BASE_VAR: "base" });
        expect(result.stdout.trim()).toBe("base-task");
    });

    test("timeout kills long-running process", async () => {
        const task: Task = {
            id: "timeout-test",
            cmd: ["sleep", "10"],
            env: {},
            dependencies: [],
            timeout: 100, // 100ms timeout
        };
        const result = await runTask(task);
        expect(result.exitCode).toBe(124);
        expect(result.durationMs).toBeLessThan(5000); // Should be ~100ms, not 10s
    });

    test("captures stderr", async () => {
        const task: Task = {
            id: "stderr-test",
            cmd: ["bash", "-c", "echo error-output >&2"],
            env: {},
            dependencies: [],
            timeout: 0,
        };
        const result = await runTask(task);
        expect(result.stderr.trim()).toBe("error-output");
    });
});
