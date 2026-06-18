/**
 * @file planner.ts
 * @description Resolves synthetic Directed Acyclic Graphs and groups tasks into parallel execution waves.
 */

import { VolatilityForecaster } from "../core/volatility_forecaster";
import path from "path";
import os from "os";

export interface OrchestratorTask {
    id: string;
    cmd: string[];
    claims: string[];   // Resource claims (e.g., "fs:db/local.sqlite", "env:PORT")
    deps: string[];     // Task IDs this task depends on
    reads?: string[];   // Filesystem paths read by the task
    writes?: string[];  // Filesystem paths written by the task
    secrets?: string[]; // Secret names resolved at runtime (never hashed/logged)
    when?: { branch?: string; platform?: string[]; if?: string };
}

export interface Wave {
    depth: number;
    taskIds: string[];
}

export interface DAGPlan {
    tasks: Map<string, OrchestratorTask>;
    inDegree: Map<string, number>;
    dependents: Map<string, string[]>;
    waves: Wave[]; // Legacy compatibility structure
}

export class WavePlanner {
    /**
     * Plan a continuous-flow Directed Acyclic Graph (DAG) and legacy Waves.
     */
    static planDAG(tasks: OrchestratorTask[], forecaster?: VolatilityForecaster): DAGPlan {
        if (tasks.length === 0) return { tasks: new Map(), inDegree: new Map(), dependents: new Map(), waves: [] };

        const taskMap = new Map<string, OrchestratorTask>();
        for (const t of tasks) {
            const readClaims = new Set<string>();
            const writeClaims = new Set<string>();
            
            if (t.reads) t.reads.forEach(r => readClaims.add(path.normalize(r.replace(/^fs:/, ""))));
            if (t.writes) t.writes.forEach(w => writeClaims.add(path.normalize(w.replace(/^fs:/, ""))));
            if (t.claims) {
                t.claims.forEach(c => {
                    if (c.startsWith("fs:")) {
                        const p = path.normalize(c.slice(3));
                        readClaims.add(p);
                        writeClaims.add(p);
                    } else {
                        writeClaims.add(c);
                    }
                });
            }
            t.reads = Array.from(readClaims);
            t.writes = Array.from(writeClaims);
            t.claims = Array.from(new Set([...t.reads.map(r => `fs:${r}`), ...t.writes.map(w => w.includes(":") ? w : `fs:${w}`)]));
            taskMap.set(t.id, t);
        }

        const inDegree = new Map<string, number>();
        const dependents = new Map<string, string[]>();

        for (const t of tasks) {
            inDegree.set(t.id, 0);
            dependents.set(t.id, []);
        }

        for (const t of tasks) {
            for (const dep of t.deps) {
                if (!taskMap.has(dep)) {
                    throw new Error(`Missing dependency: Task '${t.id}' depends on '${dep}' which does not exist.`);
                }
                inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
                dependents.get(dep)?.push(t.id);
            }
        }

        const depthGroups: string[][] = [];
        let queue = [...inDegree.entries()].filter(([_, d]) => d === 0).map(([id]) => id);

        const inDegreeCopy = new Map(inDegree);
        let processedCount = 0;

        while (queue.length > 0) {
            depthGroups.push([...queue]);
            processedCount += queue.length;
            const next: string[] = [];
            for (const id of queue) {
                for (const child of dependents.get(id) ?? []) {
                    const newDeg = (inDegreeCopy.get(child) ?? 1) - 1;
                    inDegreeCopy.set(child, newDeg);
                    if (newDeg === 0) next.push(child);
                }
            }
            queue = next;
        }

        if (processedCount < tasks.length) {
            throw new Error("Cycle detected in task dependencies.");
        }

        const waves: Wave[] = [];
        const lastAccessors: { id: string, reads: string[], writes: string[] }[] = [];

        for (const group of depthGroups) {
            if (forecaster) {
                group.sort((a, b) => {
                    const fA = forecaster.forecast(a);
                    const fB = forecaster.forecast(b);
                    return fB.volatilityScore - fA.volatilityScore;
                });
            }
            const subWaves = this.splitByClaims(group, taskMap);
            for (const sw of subWaves) {
                waves.push({ depth: waves.length, taskIds: sw });

                for (const curr of sw) {
                    const taskReads = taskMap.get(curr)!.reads || [];
                    const taskWrites = taskMap.get(curr)!.writes || [];
                    
                    // Inject synthetic dependencies to serialize across ALL overlapping tasks
                    for (let j = lastAccessors.length - 1; j >= 0; j--) {
                        const prev = lastAccessors[j];
                        let overlaps = false;
                        
                        // curr Read overlaps with prev Write
                        for (const claimA of taskReads) {
                            for (const claimB of prev.writes) {
                                if (this.claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                            }
                            if (overlaps) break;
                        }
                        // curr Write overlaps with prev Read OR prev Write
                        if (!overlaps) {
                            for (const claimA of taskWrites) {
                                for (const claimB of prev.reads) {
                                    if (this.claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                                }
                                if (overlaps) break;
                                for (const claimB of prev.writes) {
                                    if (this.claimsOverlap(claimA, claimB)) { overlaps = true; break; }
                                }
                                if (overlaps) break;
                            }
                        }
                        
                        if (overlaps) {
                            // Inject dependency
                            inDegree.set(curr, (inDegree.get(curr) ?? 0) + 1);
                            const deps = dependents.get(prev.id) ?? [];
                            deps.push(curr);
                            dependents.set(prev.id, deps);
                            // We don't break early because a task might overlap multiple concurrent previous tasks
                        }
                    }
                    
                    lastAccessors.push({ id: curr, reads: taskReads, writes: taskWrites });
                }
            }
        }

        return { tasks: taskMap, inDegree, dependents, waves };
    }

    /**
     * Legacy entry point
     */
    static plan(tasks: OrchestratorTask[], forecaster?: VolatilityForecaster): Wave[] {
        return this.planDAG(tasks, forecaster).waves;
    }

    /**
     * Greedy graph coloring: partition a set of task IDs into sub-groups
     * where no two tasks in the same sub-group share a claim.
     */
    private static splitByClaims(
        taskIds: string[],
        taskMap: Map<string, OrchestratorTask>
    ): string[][] {
        const subWaves: { ids: string[]; reads: Set<string>; writes: Set<string> }[] = [];

        for (const id of taskIds) {
            const task = taskMap.get(id)!;
            const taskReads = task.reads || [];
            const taskWrites = task.writes || [];

            // Try to fit into an existing sub-wave
            let placed = false;
            for (const sw of subWaves) {
                let overlaps = false;
                
                // curr Read overlaps with sw Write
                for (const claim of taskReads) {
                    for (const swWrite of sw.writes) {
                        if (this.claimsOverlap(claim, swWrite)) { overlaps = true; break; }
                    }
                    if (overlaps) break;
                }
                
                // curr Write overlaps with sw Read OR sw Write
                if (!overlaps) {
                    for (const claim of taskWrites) {
                        for (const swRead of sw.reads) {
                            if (this.claimsOverlap(claim, swRead)) { overlaps = true; break; }
                        }
                        if (overlaps) break;
                        for (const swWrite of sw.writes) {
                            if (this.claimsOverlap(claim, swWrite)) { overlaps = true; break; }
                        }
                        if (overlaps) break;
                    }
                }

                if (!overlaps) {
                    sw.ids.push(id);
                    for (const c of taskReads) sw.reads.add(c);
                    for (const c of taskWrites) sw.writes.add(c);
                    placed = true;
                    break;
                }
            }

            // If no existing sub-wave works, create a new one
            if (!placed) {
                subWaves.push({ ids: [id], reads: new Set(taskReads), writes: new Set(taskWrites) });
            }
        }

        return subWaves.map(sw => sw.ids);
    }

    private static claimsOverlap(claimA: string, claimB: string): boolean {
        const isCaseInsensitive = os.platform() === "win32" || os.platform() === "darwin";
        
        let a = isCaseInsensitive ? claimA.toLowerCase() : claimA;
        let b = isCaseInsensitive ? claimB.toLowerCase() : claimB;
        
        const aProtoMatch = a.match(/^([a-z0-9]{2,}):(.*)$/i);
        const bProtoMatch = b.match(/^([a-z0-9]{2,}):(.*)$/i);
        
        const aProto = aProtoMatch ? aProtoMatch[1].toLowerCase() : "fs";
        const bProto = bProtoMatch ? bProtoMatch[1].toLowerCase() : "fs";
        
        if (aProto !== bProto) return false;
        
        const aPath = aProtoMatch ? aProtoMatch[2] : a;
        const bPath = bProtoMatch ? bProtoMatch[2] : b;
        
        if (aProto === "fs") {
            const absA = path.resolve("/", aPath);
            const absB = path.resolve("/", bPath);
            
            if (absA === absB) return true;
            
            // Appending a trailing separator ensures strict directory boundary matching.
            // Example: /src/db overlaps /src/db/file.ts, but /src/db DOES NOT overlap /src/db_backup.
            const prefixA = absA.endsWith(path.sep) ? absA : absA + path.sep;
            const prefixB = absB.endsWith(path.sep) ? absB : absB + path.sep;
            
            if (absB.startsWith(prefixA) || absA.startsWith(prefixB)) return true;
            
            return false;
        }
        
        // For non-filesystem claims (like db:), use exact string matching
        return aPath === bPath;
    }
}
