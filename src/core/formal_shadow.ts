/**
 * @file formal_shadow.ts
 * @description Implements formal verification to prove absolute path disjointness between concurrent execution waves.
 */

import {
    IsolationAttestationSchema,
    type IsolationAttestation as StructuredAttestation,
} from "./attestation_schema";
import { ResourcePrefixTree } from "../formal/prefix_tree";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskResourceClaim {
    id: string;
    reads: string[];
    writes: string[];
    envReads: string[];
    envWrites: string[];
    claims?: string[];
}

export interface PairResult {
    isolated: boolean;
    conflictingResources: string[];
    hasConflict: boolean;
    /** When there is a conflict, the witnessing path (the counterexample) */
    counterexample?: string;
}

export interface WaveConflict {
    taskA: string;
    taskB: string;
    resources: string[];
    counterexample?: string;
}

export interface WaveResult {
    verified: boolean;
    conflicts: WaveConflict[];
    attestation?: {
        proofType: "FORMAL_PREFIX_TREE";
        taskIds: string[];
        hash: string;
        timestamp: number;
    };
}

// ─── Prover ──────────────────────────────────────────────────────────────────

// (Legacy TrieNode and ResourceTrie removed in favor of O(N log N) ResourcePrefixTree)

export class FormalShadow {
    static getPool(): any {
        return null;
    }

    static shutdownPool(): void {}

    static async getVerifierVersion(): Promise<string> {
        return "1.0.0";
    }

    static getVerifierEngine(): string {
        return "PREFIX_TREE";
    }

    /**
     * Verify that two tasks can run in parallel without side-effect leakage.
     *
     * Uses prefix matching to check if there exists any path P
     * that falls within both:
     *   - A's write region AND B's access region, OR
     *   - B's write region AND A's access region
     */
    static async verifyPairIsolation(
        taskA: TaskResourceClaim,
        taskB: TaskResourceClaim,
    ): Promise<PairResult> {
        const waveResult = await this.verifyWave([taskA, taskB]);
        if (waveResult.verified) {
            return { isolated: true, conflictingResources: [], hasConflict: false };
        } else {
            const conflict = waveResult.conflicts[0];
            return {
                isolated: false,
                conflictingResources: conflict.resources,
                hasConflict: true,
                counterexample: conflict.resources[0],
            };
        }
    }

    /**
     * Verify an entire wave of concurrent tasks.
     * 
     * Uses a ResourceTrie for O(N * M) verification where N is number of tasks
     * and M is average number of claims per task.
     */
    static async verifyWave(wave: TaskResourceClaim[]): Promise<WaveResult> {
        const tree = new ResourcePrefixTree();
        const conflicts: WaveConflict[] = [];
        const conflictSet = new Set<string>();

        const addConflict = (taskA: string, taskB: string, r: string) => {
            const [a, b] = [taskA, taskB].sort();
            const pair = `${a}:${b}`;
            if (!conflictSet.has(pair)) {
                conflictSet.add(pair);
                conflicts.push({
                    taskA: a,
                    taskB: b,
                    resources: [r.replace(/^fs:/, "").replace(/^env:/, "")],
                    counterexample: r,
                });
            }
        };

        for (const task of wave) {
            const checkAndAdd = (resources: string[], type: "read"|"write") => {
                for (const r of resources) {
                    const overlaps = tree.findConflicts(r, task.id, type);
                    for (const otherId of overlaps) {
                        addConflict(task.id, otherId, r);
                    }
                    tree.insert(r, task.id, type);
                }
            };
            
            checkAndAdd(task.reads.map(r => `fs:${r}`), "read");
            checkAndAdd(task.writes.map(w => `fs:${w}`), "write");
            checkAndAdd(task.envReads.map(r => `env:${r}`), "read");
            checkAndAdd(task.envWrites.map(w => `env:${w}`), "write");

            // Exact-match resources (port, db, etc.): two tasks claiming same resource
            // with at least one writer = collision. Not hierarchical like fs paths.
            for (const claim of (task.claims || [])) {
              const prefix = claim.split(":")[0];
              if (prefix === "fs" || prefix === "env") continue; // handled above
              for (const other of wave) {
                if (other.id === task.id) continue;
                if ((other.claims || []).includes(claim)) {
                  addConflict(task.id, other.id, claim);
                }
              }
            }
        }

        for (const conflict of conflicts) {
            import("../server/stream_engine").then(({ StreamEngine }) => {
                StreamEngine.broadcast("collision_detected", {
                    taskA: conflict.taskA,
                    taskB: conflict.taskB,
                    conflictingResources: conflict.resources,
                    counterexample: conflict.counterexample,
                });
            }).catch(() => { });
        }

        const verified = conflicts.length === 0;

        let attestation: WaveResult["attestation"];
        if (verified) {
            const taskIds = wave.map(t => t.id);
            const proofPayload = JSON.stringify({
                proofType: "FORMAL_PREFIX_TREE",
                solverEngine: "PREFIX_TREE",
                taskIds,
                timestamp: Date.now(),
                wave: wave.map(t => ({
                    id: t.id,
                    reads: t.reads.sort(),
                    writes: t.writes.sort(),
                    envReads: t.envReads.sort(),
                    envWrites: t.envWrites.sort(),
                })),
            });

            const hash = new Bun.CryptoHasher("sha256")
                .update(proofPayload)
                .digest("hex");

            attestation = {
                proofType: "FORMAL_PREFIX_TREE",
                taskIds,
                hash,
                timestamp: Date.now(),
            };
        }

        return { verified, conflicts, attestation };
    }

    private static checkOverlap(claimsA: string[], claimsB: string[]): string | null {
        for (const claimA of claimsA) {
            for (const claimB of claimsB) {
                if (claimA === claimB) return claimA;

                if (claimA.startsWith("fs:") && claimB.startsWith("fs:")) {
                    const pathA = claimA.slice(3);
                    const pathB = claimB.slice(3);

                    if (pathA.endsWith("/") && pathB.startsWith(pathA)) return claimB;
                    if (pathB.endsWith("/") && pathA.startsWith(pathB)) return claimA;
                }
            }
        }
        return null;
    }

    /**
     * Identify "Shadowing" conflicts — where one task's write is deterministically
     * masked by a downstream task's write.
     */
    static async detectShadowing(
        tasks: TaskResourceClaim[],
        dependencies: Map<string, string[]>
    ): Promise<WaveConflict[]> {
        const shadows: WaveConflict[] = [];
        const taskMap = new Map(tasks.map(t => [t.id, t]));

        for (const task of tasks) {
            const transitives = this.getTransitiveDependencies(task.id, dependencies);
            for (const depId of transitives) {
                const dep = taskMap.get(depId);
                if (!dep) continue;

                if (task.writes.length > 0 && dep.writes.length > 0) {
                    const taskWrites = task.writes.map(w => `fs:${w}`);
                    const depWrites = dep.writes.map(w => `fs:${w}`);
                    const conflict = this.checkOverlap(taskWrites, depWrites);

                    if (conflict) {
                        shadows.push({
                            taskA: dep.id,
                            taskB: task.id,
                            resources: [conflict.replace(/^fs:/, "").replace(/^env:/, "")],
                            counterexample: `Deterministic shadow: ${task.id} overwrites ${dep.id} at ${conflict}`,
                        });
                    }
                }
            }
        }

        return shadows;
    }

    private static getTransitiveDependencies(
        taskId: string,
        dependencies: Map<string, string[]>
    ): Set<string> {
        const result = new Set<string>();
        const stack = [...(dependencies.get(taskId) ?? [])];

        while (stack.length > 0) {
            const current = stack.pop()!;
            if (!result.has(current)) {
                result.add(current);
                stack.push(...(dependencies.get(current) ?? []));
            }
        }

        return result;
    }

    /**
     * Generate a structured Isolation Attestation.
     */
    static async attest(
        claims: TaskResourceClaim[],
        logicHash: string,
    ): Promise<StructuredAttestation> {
        const start = performance.now();
        const waveResult = await this.verifyWave(claims);
        const durationMs = performance.now() - start;

        const resourcePayload = JSON.stringify(
            claims.map(c => ({
                id: c.id,
                reads: c.reads.sort(),
                writes: c.writes.sort(),
                envReads: c.envReads.sort(),
                envWrites: c.envWrites.sort(),
            }))
        );
        const resourceSetHash = new Bun.CryptoHasher("sha256")
            .update(resourcePayload)
            .digest("hex");

        const attestation = IsolationAttestationSchema.parse({
            verified_at: new Date().toISOString(),
            verifier: {
                engine: "PREFIX_TREE",
                version: "1.0.0",
                duration_ms: durationMs,
                result: waveResult.verified ? "VERIFIED" : "COLLISION",
            },
            proof: {
                isolation_level: waveResult.verified ? "FORMAL" : "NONE",
                logic_hash: logicHash,
                resource_set_hash: resourceSetHash,
            },
        });

        return attestation;
    }
}
