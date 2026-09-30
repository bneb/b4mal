/**
 * @file executor.ts
 * @description Spawns and manages isolated subprocesses for execution wave tasks.
 */

import type { OrchestratorTask, DAGPlan, Wave } from "./planner";
import { StreamEngine } from "../server/stream_engine";
import { EnvSanitizer } from "../guard/env_sanitizer";
import { ArtifactVault } from "../core/artifact_vault";
import { ContentHasher, Semaphore } from "../core/content_hasher";
import { computeCacheKey } from "./cache_key";
import { SQLiteLedger } from "../core/sqlite_ledger";
import { RemoteVault } from "../core/remote_vault";
import { join } from "path";
import { existsSync } from "fs";
import { homedir, cpus } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WaveResult {
    taskId: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    cached: boolean;
    /**
     * True when the task never ran because a dependency it transitively requires
     * failed. `exitCode` is 1 in that case so the build is correctly reported as
     * unsuccessful, but the CLI renders it as skipped rather than failed.
     */
    skipped?: boolean;
    /**
     * True when the task was skipped by its own `when` condition (platform or
     * branch). Distinct from `skipped`, which means a dependency failed. Not a
     * cache hit: nothing was restored, nothing ran.
     */
    skippedByCondition?: boolean;
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


        const concurrency = config?.concurrency ?? cpus().length;
        const inDegree = new Map(dag.inDegree);
        const readyQueue: string[] = [];

        // Initial unblocked tasks
        for (const [id, count] of inDegree.entries()) {
            if (count === 0) readyQueue.push(id);
        }

        let activeCount = 0;
        const totalTasks = dag.tasks.size;

        if (totalTasks === 0) {
            ledger?.close();
            return [];
        }

        return new Promise<WaveResult[]>((resolve) => {
            /** Tasks that have a settled result (executed, errored, or skipped). */
            const settled = new Map<string, WaveResult>();
            let resolved = false;

            /** Close the ledger and resolve once every task is accounted for. */
            const settleIfComplete = () => {
                if (resolved || settled.size < totalTasks) return;
                resolved = true;
                ledger?.close();
                resolve([...settled.values()]);
            };

            /**
             * A failed task must not unblock its dependents. Walk the transitive
             * dependents of a failure and record each as skipped, so downstream
             * work never runs against inputs that were never produced.
             */
            const skipDependentsOf = (failedId: string) => {
                const stack = [failedId];
                while (stack.length > 0) {
                    const current = stack.pop()!;
                    for (const dependent of dag.dependents.get(current) ?? []) {
                        if (settled.has(dependent)) continue;
                        settled.set(dependent, {
                            taskId: dependent,
                            exitCode: 1,
                            stdout: "",
                            stderr: `Skipped: dependency '${current}' failed.`,
                            durationMs: 0,
                            cached: false,
                            skipped: true,
                        });
                        stack.push(dependent);
                    }
                }
            };

            const dispatch = async () => {
                while (readyQueue.length > 0 && activeCount < concurrency) {
                    let taskId: string;
                    if (config?.chaos) {
                        const randomIndex = Math.floor(Math.random() * readyQueue.length);
                        taskId = readyQueue.splice(randomIndex, 1)[0];
                    } else {
                        taskId = readyQueue.shift()!;
                    }

                    // A task may be enqueued by a successful parent after another
                    // parent already failed and skipped it. Never run it.
                    if (settled.has(taskId)) continue;

                    const task = dag.tasks.get(taskId)!;

                    activeCount++;

                    this.executeTask(task, config, ledger).then((result) => {
                        settled.set(taskId, result);
                    }).catch((err: unknown) => {
                        const message = err instanceof Error ? err.message : String(err);
                        settled.set(taskId, {
                            taskId,
                            exitCode: 1,
                            stdout: "",
                            stderr: message,
                            durationMs: 0,
                            cached: false,
                        });
                    }).finally(() => {
                        activeCount--;

                        const result = settled.get(taskId);
                        const failed = !result || result.exitCode !== 0;

                        if (failed) {
                            // Do not unblock dependents: skip them instead.
                            skipDependentsOf(taskId);
                        } else {
                            // Unblock downstream dependents
                            for (const dependent of dag.dependents.get(taskId) || []) {
                                const currentCount = inDegree.get(dependent)! - 1;
                                inDegree.set(dependent, currentCount);
                                if (currentCount === 0) {
                                    readyQueue.push(dependent);
                                }
                            }
                        }

                        // Broadcast completion for HUD
                        StreamEngine.broadcast("wave_complete", {
                            depth: 0,
                            tasks: 1,
                            durationMs: 0,
                            taskIds: [taskId],
                        });

                        settleIfComplete();
                        if (!resolved) dispatch();
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
        const envClaims = task.claims
            .filter(c => c.startsWith("env:"))
            .map(c => c.replace(/^env:/, ""));

        // Environment variables the task reads, from both `env:` claims and the
        // lockfile's `needsEnv`. The latter was previously dropped on the floor:
        // it never reached the sanitizer, so a task declaring `needsEnv` was
        // silently denied those variables at runtime.
        const requestedEnv = [...new Set([...envClaims, ...(task.envReads ?? [])])];

        const writes = task.writes ?? [];
        const producesArtifact = writes.length > 0;

        // ── Compute cache hash ────────────────────────────────────────
        // Keyed on DECLARED INPUTS ONLY. `task.claims` is inputs + outputs +
        // explicit claims, so hashing it directly would make the key depend on
        // the task's own output content. See src/orchestrator/cache_key.ts.
        const logicHash = projectRoot
            ? await computeCacheKey(
                {
                    id: task.id, cmd: task.cmd, reads: task.reads, writes: task.writes,
                    claims: task.claims, envReads: task.envReads,
                },
                projectRoot,
            )
            : undefined;

        const skipCache = config?.force === true;

        // ── Conditional execution: skip if when conditions not met ─────
        //
        // This sits BEFORE the cache checks, deliberately. The cache key is the
        // task's command plus its declared inputs — it does not include `when` —
        // so a task gated to one platform shares a key with the same task on
        // another. Evaluated after the caches (where it used to sit), an L2
        // artifact produced on Linux would be restored on macOS for a task that is
        // supposed to be skipped there, reporting success and writing outputs that
        // should never have existed on that machine.
        if (task.when) {
          const w = task.when;
          if (w.platform && !w.platform.includes(process.platform)) {
            return {
              taskId: task.id, exitCode: 0,
              stdout: `[skipped — platform ${process.platform} not in ${w.platform}]`,
              stderr: "", durationMs: 0,
              // Not a cache hit: nothing was restored and nothing ran. Reporting
              // `cached: true` here made the CLI print "↩ (cached)" and count the
              // task among its cache hits, which is not what happened.
              cached: false, skippedByCondition: true,
            };
          }
          if (w.branch) {
            const branch = process.env.GIT_BRANCH || process.env.CI_COMMIT_BRANCH || "";
            const matches = branch === w.branch || new RegExp(`^${w.branch.replace(/\*/g, ".*")}$`).test(branch);
            if (branch && !matches) {
              return {
                taskId: task.id, exitCode: 0,
                stdout: `[skipped — branch "${branch}" doesn't match "${w.branch}"]`,
                stderr: "", durationMs: 0,
                cached: false, skippedByCondition: true,
              };
            }
          }
        }

        // ── L2: Remote Cache Check (before L1 — shared cache is fresher) ─
        if (!skipCache && logicHash && config?.remoteVault && projectRoot) {
          try {
            const l2Result = await config.remoteVault.checkAndPull(logicHash, projectRoot);
            if (l2Result) {
              // checkAndPull downloads the archive and promotes it into the L1
              // vault, but promoting only writes the archive — it does not put
              // the task's files back. Without this unpack an L2 hit reported
              // success and a cache hit while the declared outputs were absent
              // from the workspace, which is exactly the fresh-CI-runner case
              // the remote cache exists for.
              if (producesArtifact) {
                await ArtifactVault.unpack(logicHash, projectRoot);
              }

              // Record the promoted artifact so it is usable as a local cache
              // entry. Without this the L1 copy just written was dead weight:
              // the L1 branch requires a ledger entry, so the next run would go
              // back to the network, and would re-execute if the remote were
              // unreachable despite having a perfectly good archive on disk.
              ledger?.recordEntry({
                logicHash,
                taskId: task.id,
                action: "l2-hit",
                timestamp: Date.now(),
                stdout: "[L2 cache hit — restored from remote vault]",
                stderr: "",
                durationMs: l2Result.durationMs ?? 0,
                exitCode: l2Result.exitCode ?? 0,
              });

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
            // Includes a failed unpack: fall through to L1 and, if that misses,
            // to execution, rather than reporting a hit we could not restore.
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
            requestedEnv,
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
            // Pack BEFORE recording. A ledger entry is a promise that the result
            // can be restored; if packing fails there is no artifact to restore
            // from, and recording anyway would leave a permanent un-restorable
            // entry that silently degrades every later run to a cache miss.
            let cacheable = true;

            if (projectRoot && producesArtifact) {
                // A task that declared outputs but did not produce them cannot be
                // cached: there is nothing to archive, and the declared `outputs`
                // are wrong. Report that precisely instead of surfacing tar's
                // "Cannot stat" internals.
                const missing = writes.filter(w => !existsSync(join(projectRoot, w)));

                if (missing.length > 0) {
                    cacheable = false;
                    process.stderr.write(
                        `\x1b[2m[Cache] '${task.id}' declared output(s) not produced: ` +
                        `${missing.join(", ")} — task will not be cached.\x1b[0m\n`
                    );
                } else {
                    try {
                        await ArtifactVault.pack(logicHash, projectRoot, writes);
                    } catch (err) {
                        cacheable = false;
                        process.stderr.write(
                            `\x1b[2m[Cache] pack failed for '${task.id}': ${err instanceof Error ? err.message : err}\x1b[0m\n`
                        );
                    }
                }
            }

            if (cacheable) {
                ledger?.recordEntry({
                    logicHash,
                    taskId: task.id,
                    action: "execute",
                    timestamp: Date.now(),
                    stdout: stdout.trim(),
                    stderr: stderr.trim(),
                    durationMs,
                });
            }

            // L2 push (non-fatal — build continues on failure)
            if (projectRoot && config?.remoteVault) {
              try {
                // No signature here: RemoteVault signs the payload itself, so
                // there is one place that decides how entries are authenticated.
                await config.remoteVault.pushWithMetadata(logicHash, projectRoot, {
                  logicHash,
                  taskId: task.id,
                  exitCode,
                  durationMs,
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
