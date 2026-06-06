/**
 * B4mal v0.1.0 — DAG Scheduler
 *
 * Kahn's algorithm for topological sort + wave-based parallel execution.
 * Cycle detection. Critical path tracking.
 */
import type { Task } from "./schema";

export interface DagWave {
    /** Depth level in the DAG (0 = root tasks with no deps) */
    depth: number;
    /** Task IDs in this wave (can all run in parallel) */
    taskIds: string[];
}

export interface DagPlan {
    /** Ordered waves for execution */
    waves: DagWave[];
    /** Task ID → depth mapping */
    depths: Map<string, number>;
    /** Critical path: longest chain of dependent tasks */
    criticalPath: string[];
}

/**
 * Resolve a set of tasks into a topologically sorted wave plan.
 * Throws on cycle detection or missing dependencies.
 */
export function buildDag(tasks: Task[]): DagPlan {
    const taskMap = new Map<string, Task>();
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // parent → children that depend on it

    // Index tasks
    for (const task of tasks) {
        if (taskMap.has(task.id)) {
            throw new Error(`Duplicate task ID: "${task.id}"`);
        }
        taskMap.set(task.id, task);
        inDegree.set(task.id, 0);
        dependents.set(task.id, []);
    }

    // Build adjacency
    for (const task of tasks) {
        for (const dep of task.dependencies) {
            if (!taskMap.has(dep)) {
                throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
            }
            inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
            dependents.get(dep)!.push(task.id);
        }
    }

    // Kahn's algorithm — group by wave depth
    const waves: DagWave[] = [];
    const depths = new Map<string, number>();
    let queue: string[] = [];

    // Seed: all tasks with in-degree 0
    for (const [id, deg] of inDegree) {
        if (deg === 0) {
            queue.push(id);
            depths.set(id, 0);
        }
    }

    let processed = 0;

    while (queue.length > 0) {
        // Current wave depth
        const depth = waves.length;
        waves.push({ depth, taskIds: [...queue] });

        const nextQueue: string[] = [];

        for (const id of queue) {
            processed++;
            for (const child of dependents.get(id)!) {
                const newDeg = (inDegree.get(child) ?? 1) - 1;
                inDegree.set(child, newDeg);
                if (newDeg === 0) {
                    nextQueue.push(child);
                    depths.set(child, depth + 1);
                }
            }
        }

        queue = nextQueue;
    }

    if (processed !== tasks.length) {
        throw new Error(
            `Dependency cycle detected. Processed ${processed}/${tasks.length} tasks.`
        );
    }

    // Critical path: longest chain via reverse traversal
    const criticalPath = findCriticalPath(tasks, depths, taskMap);

    return { waves, depths, criticalPath };
}

/**
 * Find the longest dependency chain (by count, not by time — v0.1.0).
 * Time-weighted critical path is a v1.0.0 feature.
 */
function findCriticalPath(
    tasks: Task[],
    depths: Map<string, number>,
    taskMap: Map<string, Task>
): string[] {
    if (tasks.length === 0) return [];

    // Find the deepest task
    let deepestId = tasks[0].id;
    let maxDepth = 0;

    for (const [id, depth] of depths) {
        if (depth > maxDepth) {
            maxDepth = depth;
            deepestId = id;
        }
    }

    // Walk backwards from deepest
    const path: string[] = [deepestId];
    let currentId = deepestId;

    while (true) {
        const task = taskMap.get(currentId)!;
        if (task.dependencies.length === 0) break;

        // Pick the deepest parent
        let bestParent = task.dependencies[0];
        let bestDepth = depths.get(bestParent) ?? 0;

        for (const dep of task.dependencies) {
            const depDepth = depths.get(dep) ?? 0;
            if (depDepth > bestDepth) {
                bestParent = dep;
                bestDepth = depDepth;
            }
        }

        path.unshift(bestParent);
        currentId = bestParent;
    }

    return path;
}

/**
 * Format a DAG plan for dry-run display.
 */
export function formatDagPlan(plan: DagPlan, tasks: Task[]): string {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const lines: string[] = ["", "  DAG Execution Plan", "  ══════════════════"];

    for (const wave of plan.waves) {
        lines.push(`\n  Wave ${wave.depth} (${wave.taskIds.length} task${wave.taskIds.length > 1 ? "s" : ""}, parallel):`);
        for (const id of wave.taskIds) {
            const task = taskMap.get(id)!;
            const deps = task.dependencies.length > 0 ? ` ← [${task.dependencies.join(", ")}]` : "";
            lines.push(`    ● ${id}: ${task.cmd.join(" ")}${deps}`);
        }
    }

    lines.push(`\n  Critical path: ${plan.criticalPath.join(" → ")}`);
    lines.push(`  Max depth: ${plan.waves.length}`);
    lines.push("");

    return lines.join("\n");
}
