/**
 * @file planner.ts
 * @description Resolves synthetic Directed Acyclic Graphs and groups tasks into parallel execution waves.
 */

import { VolatilityForecaster } from "../core/volatility_forecaster";
import { ResourcePrefixTree } from "../formal/prefix_tree";
import path from "path";
import os from "os";

export interface OrchestratorTask {
    id: string;
    cmd: string[];
    claims: string[];   // Resource claims (e.g., "fs:db/local.sqlite", "env:PORT")
    deps: string[];     // Task IDs this task depends on
    reads?: string[];   // Filesystem paths read by the task
    writes?: string[];  // Filesystem paths written by the task
    /**
     * Environment variable NAMES the task reads (from the lockfile's
     * `needsEnv`). These are passed to the EnvSanitizer and their values are
     * hashed into the cache key — the architecture doc promises declared env
     * values are cache inputs, and without them a changed variable produced a
     * stale cache hit.
     */
    envReads?: string[];
    /** Environment variable NAMES the task sets. */
    envWrites?: string[];
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

        /**
         * The planner's normalized view of each task's resource access.
         *
         * Kept SEPARATE from the task objects on purpose. Planning folds every
         * `fs:` claim into both reads and writes, because a claim asserts
         * "this task touches the path" without saying which way. Writing that
         * normalization back onto `t.reads`/`t.writes` destroyed the author's
         * declared distinction, and those objects are handed to the executor,
         * which uses `reads` for the cache key and `writes` for artifact
         * packing. The result was that declared *inputs* were treated as
         * outputs: inputs were archived as artifacts and excluded from cache
         * keys, so editing a source file could still produce a cache hit.
         */
        const accessMap = new Map<string, { reads: string[]; writes: string[] }>();

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

            accessMap.set(t.id, {
                reads: Array.from(readClaims),
                writes: Array.from(writeClaims),
            });
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

        // Overlap index over every accessor accepted so far, in the plan order.
        //
        // This used to be a linear scan of `lastAccessors` for each task, which is
        // O(n^2): every task compared itself against every previously-accepted
        // task. At 2,000 tasks that already cost 6s and doubled the input
        // multiplied the time by ~5; 100,000 tasks — a plausible monorepo — would
        // have taken hours.
        //
        // ResourcePrefixTree answers "which accepted tasks conflict with these
        // claims?" in one lookup, giving the same edges in O(log n)-ish time.
        //
        // Semantics match claimsOverlap exactly, because accessMap has already
        // normalised every filesystem claim to a bare path (stripping `fs:`) while
        // leaving opaque protocol claims (`env:PORT`, `db:primary`) intact. The
        // tree applies directory-boundary matching to the former and exact-segment
        // matching to the latter — which is what claimsOverlap does for each class.
        const overlapIndex = new ResourcePrefixTree();
        /** Tasks conflicting with `id`, as computed by the shared tree semantics. */
        const conflictsFor = (id: string, access: { reads: string[]; writes: string[] }): Set<string> => {
            const found = new Set<string>();
            // A read conflicts with a prior write; a write conflicts with a prior
            // read or a prior write. Mirror the two loops of the original scan.
            for (const claim of access.reads) {
                for (const other of overlapIndex.findConflicts(claim, id, "read")) found.add(other);
            }
            for (const claim of access.writes) {
                for (const other of overlapIndex.findConflicts(claim, id, "write")) found.add(other);
            }
            return found;
        };

        for (const group of depthGroups) {
            if (forecaster) {
                group.sort((a, b) => {
                    const fA = forecaster.forecast(a);
                    const fB = forecaster.forecast(b);
                    return fB.volatilityScore - fA.volatilityScore;
                });
            }
            const subWaves = this.splitByClaims(group, accessMap);
            for (const sw of subWaves) {
                waves.push({ depth: waves.length, taskIds: sw });

                for (const curr of sw) {
                    const access = accessMap.get(curr)!;
                    for (const prevId of conflictsFor(curr, access)) {
                        // Inject dependency: the overlapping task must finish first.
                        inDegree.set(curr, (inDegree.get(curr) ?? 0) + 1);
                        const deps = dependents.get(prevId) ?? [];
                        deps.push(curr);
                        dependents.set(prevId, deps);
                    }

                    // Accept this task for later comparisons by indexing its claims.
                    for (const claim of access.reads) overlapIndex.insert(claim, curr, "read");
                    for (const claim of access.writes) overlapIndex.insert(claim, curr, "write");
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
        accessMap: Map<string, { reads: string[]; writes: string[] }>
    ): string[][] {
        const subWaves: { ids: string[]; reads: Set<string>; writes: Set<string> }[] = [];

        for (const id of taskIds) {
            const access = accessMap.get(id)!;
            const taskReads = access.reads;
            const taskWrites = access.writes;

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
