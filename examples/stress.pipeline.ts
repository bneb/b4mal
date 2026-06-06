/**
 * Example: Stress Pipeline
 *
 * 100 parallel "echo" tasks for the <3ms overhead benchmark.
 * All tasks are independent (wave depth 0) — maximum parallelism.
 */
import type { Pipeline } from "../src/schema";

const tasks = Array.from({ length: 100 }, (_, i) => ({
    id: `task-${String(i).padStart(3, "0")}`,
    cmd: ["echo", `task ${i}`],
    env: {} as Record<string, string>,
    dependencies: [] as string[],
    timeout: 0,
}));

export default {
    name: "stress-100",
    tasks,
};
