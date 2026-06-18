/**
 * @file executor.ts
 * @description Spawns and manages isolated subprocesses for execution wave tasks.
 */

import type { OrchestratorTask, DAGPlan, Wave } from "./planner";
import { StreamEngine } from "../server/stream_engine";
import { EnvSanitizer } from "../guard/env_sanitizer";
import { ArtifactVault } from "../core/artifact_vault";
import { ContentHasher, Semaphore } from "../core/content_hasher";
import { SQLiteLedger } from "../core/sqlite_ledger";
import { RemoteVault } from "../core/remote_vault";
import { join } from "path";
import { homedir, cpus } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WaveResult {
    taskId: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    cached: boolean;
}

export interface ExecutorConfig {
    projectRoot: string;
    layerMergeOrder?: string[];
    concurrency?: number;
    chaos?: boolean;
    force?: boolean;
    remoteVault?: RemoteVault;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class DynamicExecutor {
    /**
     * Execute tasks dynamically as their dependencies are met (Continuous Flow).
     */
    static async run(
        dag: DAGPlan,
        config?: ExecutorConfig,
    ): Promise<WaveResult[]> {
        // ── Local Strategy: Dynamic Continuous Flow ─────────────────────────
        const ledger = config?.projectRoot
            ? new SQLiteLedger(join(config.projectRoot, ".b4mal", "cache.db"))
            : undefined;


        const allResults: WaveResult[] = [];
        const concurrency = config?.concurrency ?? cpus().length;
        const inDegree = new Map(dag.inDegree);
        const readyQueue: string[] = [];

        // Initial unblocked tasks
        for (const [id, count] of inDegree.entries()) {
            if (count === 0) readyQueue.push(id);
        }

        let completedCount = 0;
        let activeCount = 0;
        const totalTasks = dag.tasks.size;

        if (totalTasks === 0) {
            ledger?.close();
            return [];
        }

        return new Promise<WaveResult[]>((resolve) => {
            const dispatch = async () => {
                while (readyQueue.length > 0 && activeCount < concurrency) {
                    let taskId: string;
                    if (config?.chaos) {
                        const randomIndex = Math.floor(Math.random() * readyQueue.length);
                        taskId = readyQueue.splice(randomIndex, 1)[0];
                    } else {
                        taskId = readyQueue.shift()!;
                    }
                    const task = dag.tasks.get(taskId)!;
                    
                    activeCount++;
                    
                    this.executeTask(task, config, ledger).then((result) => {
                        allResults.push(result);
                    }).catch((err: unknown) => {
                        const message = err instanceof Error ? err.message : String(err);
                        allResults.push({
                            taskId,
                            exitCode: 1,
                            stdout: "",
                            stderr: message,
                            durationMs: 0,
                            cached: false,
                        });
                    }).finally(() => {
                        activeCount--;
                        completedCount++;

                        // Unblock downstream dependents
                        for (const dependent of dag.dependents.get(taskId) || []) {
                            const currentCount = inDegree.get(dependent)! - 1;
                            inDegree.set(dependent, currentCount);
                            if (currentCount === 0) {
                                readyQueue.push(dependent);
                            }
                        }

                        // Broadcast completion for HUD
                        StreamEngine.broadcast("wave_complete", {
                            depth: 0,
                            tasks: 1,
                            durationMs: 0,
                            taskIds: [taskId],
                        });

                        if (completedCount === totalTasks) {
                            ledger?.close();
                            resolve(allResults);
                        } else {
                            dispatch();
                        }
                    });
                }
            };

            // Kick off initial processing
            try {
                dispatch();
            } catch (err) {
                ledger?.close();
                throw err;
            }
        });
    }



    /**
     * Execute a single task with full cache lifecycle.
     */
    private static async executeTask(
        task: OrchestratorTask,
        config?: ExecutorConfig,
        ledger?: SQLiteLedger,
    ): Promise<WaveResult> {
        const projectRoot = config?.projectRoot;

        // ── Parse claims ──────────────────────────────────────────────
        const fsClaims = task.claims
            .filter(c => c.startsWith("fs:"))
            .map(c => c.replace(/^fs:/, ""));
        const envClaims = task.claims
            .filter(c => c.startsWith("env:"))
            .map(c => c.replace(/^env:/, ""));

        const writes = task.writes ?? [];
        const producesArtifact = writes.length > 0;
        const useLogicHash = !producesArtifact;

        // ── Compute cache hash ────────────────────────────────────────
        let logicHash: string | undefined;
        if (projectRoot && fsClaims.length > 0) {
            const hasher = new Bun.CryptoHasher("sha256");
            hasher.update(task.id);
            hasher.update(JSON.stringify(task.cmd));
            for (const claim of fsClaims.sort()) {
                const claimHash = await ContentHasher.hashPath(
                    join(projectRoot, claim),
                    { useLogicHash, projectRoot }
                );
                hasher.update(claim);
                hasher.update(claimHash);
            }
            logicHash = hasher.digest("hex");
        }

        const skipCache = config?.force === true;

        // ── L2: Remote Cache Check (before L1 — shared cache is fresher) ─
        if (!skipCache && logicHash && config?.remoteVault && projectRoot) {
          try {
            const l2Result = await config.remoteVault.checkAndPull(logicHash, projectRoot);
            if (l2Result) {
              return {
                taskId: task.id,
                exitCode: l2Result.exitCode ?? 0,
                stdout: "[L2 cache hit — restored from remote vault]",
                stderr: "",
                durationMs: l2Result.durationMs ?? 0,
                cached: true,
              };
            }
          } catch (err: any) {
            process.stderr.write(`\x1b[2m[L2] pull failed: ${err?.message || err}\x1b[0m\n`);
          }
        }

        // ── L1: Local Cache Hit? ──────────────────────────────────────
        if (!skipCache && logicHash && ledger) {
            const entry = ledger.getEntry(logicHash);
            if (entry) {
                // Tasks with no FS writes (typecheck, test) cache via ledger only —
                // their result is deterministic from inputs, no artifact to restore.
                // Tasks with FS writes need the artifact archive to also be present.
                const needsArtifact = producesArtifact;
                const hasArtifact   = !needsArtifact || ArtifactVault.hasArtifact(logicHash, projectRoot);

                if (hasArtifact) {
                    const start = performance.now();
                    if (needsArtifact && projectRoot) {
                        await ArtifactVault.unpack(logicHash, projectRoot);
                    }
                    return {
                        taskId: task.id,
                        exitCode: 0,
                        stdout: entry.stdout ?? "[L1 cache hit — restored from local vault]",
                        stderr: entry.stderr ?? "",
                        durationMs: entry.durationMs ?? (performance.now() - start),
                        cached: true,
                    };
                }
            }
        }



        // ── Cache Miss: Execute ───────────────────────────────────────
        const start = performance.now();

        const sanitizedEnv = EnvSanitizer.sanitize(
            envClaims,
            process.env as Record<string, string>,
        );

        // Inject declared secrets from host environment (never hashed, never logged)
        const secrets = task.secrets;
        if (secrets && secrets.length > 0) {
          for (const name of secrets) {
            const val = process.env[name];
            if (val !== undefined) {
              sanitizedEnv[name] = val;
            }
          }
        }

        let finalCmd = task.cmd;
        
        // Runtime Enforcement (macOS sandbox-exec)
        // If we are on macOS and the task has write claims, we can optionally
        // wrap the execution in a sandbox profile that strictly denies writes
        // outside of the claimed directories. This bridges the gap between
        // static claims and runtime reality.
        if (process.platform === "darwin" && fsClaims.length > 0) {
            const writes = fsClaims.filter(c => c.startsWith("write:")).map(c => c.replace("write:", ""));
            // Simple heuristic: if we have explicit writes, we could generate a profile.
            // For now, we note the architecture point and fall back to raw spawn,
            // as generating robust macOS profiles dynamically is complex.
        }

        const proc = Bun.spawn(finalCmd, {
            cwd: projectRoot,
            stdout: "pipe",
            stderr: "pipe",
            env: sanitizedEnv,
        });

        const exitCode = await proc.exited;
        const durationMs = performance.now() - start;

        const maxLogSize = 100 * 1024; // 100KB truncation for DB bloat prevention
        const rawStdout = await new Response(proc.stdout).text();
        const rawStderr = await new Response(proc.stderr).text();
        
        const stdout = rawStdout.length > maxLogSize ? rawStdout.slice(-maxLogSize) : rawStdout;
        const stderr = rawStderr.length > maxLogSize ? rawStderr.slice(-maxLogSize) : rawStderr;

        // ── Post-execution: Pack → Record → Upload ───────────────────
        if (exitCode === 0 && logicHash) {
            ledger?.recordEntry({
                logicHash,
                taskId: task.id,
                action: "execute",
                timestamp: Date.now(),
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                durationMs,
            });

            if (projectRoot && producesArtifact) {
                try {
                    await ArtifactVault.pack(logicHash, projectRoot, writes);
                } catch (err) {
                    console.error("Pack failed:", err);
                }
            }

            // L2 push (non-fatal — build continues on failure)
            if (projectRoot && config?.remoteVault) {
              try {
                await config.remoteVault.pushWithMetadata(logicHash, projectRoot, {
                  logicHash,
                  taskId: task.id,
                  exitCode,
                  durationMs,
                  signature: null,
                });
              } catch (err: any) {
                process.stderr.write(`\x1b[2m[L2] push failed: ${err?.message || err}\x1b[0m\n`);
              }
            }
        }

        return {
            taskId: task.id,
            exitCode,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            durationMs,
            cached: false,
        };
    }
}
