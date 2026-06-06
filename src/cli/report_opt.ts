// B4mal v2.6.0 — CLI: report --optimize
//
// Generates the Core Optimization Report from the current project's
// task graph, wave plan, and critical path analysis.

import { OptimizationReport, type OptimizationData } from "../reporter/optimization_report";
import { WavePlanner, type OrchestratorTask } from "../orchestrator/planner";

export class ReportOptimizeCommand {
    /**
     * Run the optimization report for a set of tasks.
     * In production, these tasks come from the b4mal.jsonc manifest.
     * For now, accepts tasks directly for composability.
     */
    static run(tasks: OrchestratorTask[], actualBuildMs: number): string {
        const waves = WavePlanner.plan(tasks);

        // Build critical path: tasks on the longest dependency chain
        const taskMap = new Map(tasks.map(t => [t.id, t]));
        const depths = new Map<string, number>();
        for (const wave of waves) {
            for (const id of wave.taskIds) {
                depths.set(id, wave.depth);
            }
        }

        // Find deepest task and trace back
        let maxDepth = 0;
        let deepestId = tasks[0]?.id ?? "";
        for (const [id, depth] of depths) {
            if (depth > maxDepth) { maxDepth = depth; deepestId = id; }
        }

        const path: string[] = [deepestId];
        let current = deepestId;
        while (true) {
            const task = taskMap.get(current);
            if (!task || task.deps.length === 0) break;
            let bestDep = task.deps[0];
            let bestDepth = depths.get(bestDep) ?? 0;
            for (const dep of task.deps) {
                const d = depths.get(dep) ?? 0;
                if (d > bestDepth) { bestDep = dep; bestDepth = d; }
            }
            path.unshift(bestDep);
            current = bestDep;
        }

        // Estimate durations (in production, these come from telemetry)
        const perTaskMs = actualBuildMs / tasks.length;
        const criticalPath = path.map(id => ({ id, durationMs: Math.round(perTaskMs) }));
        const theoreticalMinMs = criticalPath.reduce((sum, t) => sum + t.durationMs, 0);

        // Find refactor proposals
        const proposals: { taskA: string; taskB: string; sharedClaim: string; reason: string; suggestion: string }[] = [];
        for (let i = 0; i < tasks.length; i++) {
            for (let j = i + 1; j < tasks.length; j++) {
                const a = tasks[i], b = tasks[j];
                const claimsA = new Set(a.claims);
                for (const claim of b.claims) {
                    if (claimsA.has(claim)) {
                        proposals.push({
                            taskA: a.id, taskB: b.id, sharedClaim: claim,
                            reason: `Tasks "${a.id}" and "${b.id}" both claim "${claim}"`,
                            suggestion: `Split "${claim}" into task-specific paths`,
                        });
                    }
                }
            }
        }

        const data: OptimizationData = {
            criticalPath,
            wavePlan: waves,
            theoreticalMinMs,
            actualCurrentMs: actualBuildMs,
            proposals,
            shadowSimulations: [],
        };

        return OptimizationReport.generate(data);
    }
}
