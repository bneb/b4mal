/**
 * B4mal v1.0 — Engine Orchestrator
 *
 * Wires DAG → Runner → Cache into a single execution pipeline.
 * Structured metadata on every cache write,
 * isolation metrics rendered via TerminalReporter.
 */
import type { Pipeline, PipelineResult, Task, TaskResult } from "./schema";
import { buildDag, formatDagPlan } from "./dag";
import { runTask } from "./runner";
import { TaskCache } from "./cache";
import { Telemetry } from "./telemetry";
import { generateLogicHash } from "./core/logic_hasher";
import { TelemetryAggregator } from "./core/telemetry_aggregator";
import {
    TerminalReporter,
    reportPipelineStart,
    reportTaskStart,
    reportTaskEnd,
    reportWaveStart,
    reportPipelineEnd,
    reportDryRun,
} from "./reporter";
import { TuiReporter } from "./reporter/tui_hud";

export interface EngineOptions {
    dryRun?: boolean;
    noCache?: boolean;
    concurrency?: number;
    cacheDir?: string;
    silent?: boolean;
    /** Enable Verbose Dashboard (v1.0) */
    verbose?: boolean;
    /** Enable TUI HUD (v1.5) */
    tui?: boolean;
}

export class Engine {
    private cache: TaskCache | null;
    private telemetry: Telemetry;
    private options: EngineOptions;
    private terminalReporter: TerminalReporter | null;
    private tuiReporter: TuiReporter | null;

    constructor(options: EngineOptions = {}) {
        this.options = options;
        this.telemetry = new Telemetry();
        this.terminalReporter = options.verbose && !options.silent ? new TerminalReporter() : null;
        this.tuiReporter = null;

        if (options.noCache) {
            this.cache = null;
        } else {
            const cacheDir = options.cacheDir ?? ".b4mal";
            const fs = require("fs");
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            this.cache = new TaskCache(`${cacheDir}/cache.db`);
        }
    }

    async execute(pipeline: Pipeline): Promise<PipelineResult> {
        const taskMap = new Map(pipeline.tasks.map((t) => [t.id, t]));
        const concurrency = this.options.concurrency ?? pipeline.concurrency ?? 0;

        // ── Build DAG ──────────────────────────────────────────────────────────
        this.telemetry.mark("dag");
        const dag = buildDag(pipeline.tasks);
        this.telemetry.end("dag");

        // ── Dry Run ────────────────────────────────────────────────────────────
        if (this.options.dryRun) {
            if (!this.options.silent) {
                if (this.terminalReporter) {
                    this.terminalReporter.renderHUD(pipeline.tasks.length, pipeline.name);
                } else {
                    reportPipelineStart(pipeline.name, pipeline.tasks.length);
                }
                reportDryRun(formatDagPlan(dag, pipeline.tasks));
            }
            return {
                name: pipeline.name,
                tasks: [],
                totalDurationMs: 0,
                overheadMs: 0,
                success: true,
            };
        }

        // ── Execute ────────────────────────────────────────────────────────────
        if (!this.options.silent) {
            if (this.terminalReporter) {
                this.terminalReporter.renderHUD(pipeline.tasks.length, pipeline.name);
            } else {
                reportPipelineStart(pipeline.name, pipeline.tasks.length);
            }
        }

        this.telemetry.mark("pipeline");
        const results: TaskResult[] = [];
        const taskTimings = new Map<string, { durationMs: number; cached: boolean }>();
        let pipelineSuccess = true;

        const inDegree = new Map<string, number>();
        const dependents = new Map<string, string[]>();

        for (const task of pipeline.tasks) {
            inDegree.set(task.id, 0);
            dependents.set(task.id, []);
        }

        for (const task of pipeline.tasks) {
            for (const dep of task.dependencies) {
                inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
                dependents.get(dep)!.push(task.id);
            }
        }

        const readyQueue: Task[] = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0) readyQueue.push(taskMap.get(id)!);
        }

        if (this.options.tui && !this.options.silent) {
            this.tuiReporter = new TuiReporter(pipeline.tasks.map(t => t.id), pipeline.name);
            this.tuiReporter.start();
        }

        let runningCount = 0;
        let completedCount = 0;
        const totalCount = pipeline.tasks.length;

        const executePromise = new Promise<void>((resolve) => {
            const checkDone = () => {
                if (completedCount === totalCount || (!pipelineSuccess && runningCount === 0)) {
                    resolve();
                }
            };

            const pump = () => {
                if (!pipelineSuccess && readyQueue.length > 0) {
                    readyQueue.length = 0; // Clear queue on failure
                    return;
                }

                while (readyQueue.length > 0 && (concurrency === 0 || runningCount < concurrency)) {
                    const task = readyQueue.shift()!;
                    runningCount++;

                    this.executeSingleTask(task, pipeline.env).then((result) => {
                        runningCount--;
                        completedCount++;
                        results.push(result);
                        taskTimings.set(result.id, {
                            durationMs: result.durationMs,
                            cached: result.cacheHit !== false,
                        });

                        if (result.exitCode !== 0) {
                            pipelineSuccess = false;
                        } else if (pipelineSuccess) {
                            for (const dep of dependents.get(task.id)!) {
                                const deg = inDegree.get(dep)! - 1;
                                inDegree.set(dep, deg);
                                if (deg === 0) {
                                    readyQueue.push(taskMap.get(dep)!);
                                }
                            }
                        }

                        pump();
                        checkDone();
                    });
                }
            };

            pump();
            checkDone();
        });

        await executePromise;

        if (this.tuiReporter) {
            this.tuiReporter.stop();
        }

        this.telemetry.end("pipeline");
        const telemetryData = this.telemetry.summarize(taskTimings);

        const pipelineResult: PipelineResult = {
            name: pipeline.name,
            tasks: results,
            totalDurationMs: telemetryData.totalWallMs,
            overheadMs: telemetryData.overheadMs,
            success: pipelineSuccess,
        };

        // ── Render ─────────────────────────────────────────────────────────────
        if (!this.options.silent && !this.options.tui) {
            if (this.terminalReporter && this.cache) {
                // Isolation metrics from the database
                const tax = TelemetryAggregator.calculateTaxSaved(this.cache.db);
                this.terminalReporter.renderIsolationBar(tax);

                if (tax.logicalHits > 0 || results.length > 3) {
                    const bottleneck = TelemetryAggregator.findBottleneck(this.cache.db);
                    if (bottleneck) {
                        this.terminalReporter.renderBottleneck(bottleneck);
                    }
                }

                this.terminalReporter.renderFlightSummary(pipelineResult);
            } else {
                reportPipelineEnd(pipelineResult);
            }
        }

        return pipelineResult;
    }

    private async executeSingleTask(
        task: Task,
        baseEnv: Record<string, string>
    ): Promise<TaskResult> {
        try {
            if (!this.options.silent) {
                if (this.tuiReporter) {
                    this.tuiReporter.renderTaskStart(task.id);
                } else if (this.terminalReporter) {
                    this.terminalReporter.renderTaskStart(task.id);
                } else {
                    reportTaskStart(task.id);
                }
            }

            // Generate logic hash for dual-key cache
            const logicHash = await generateLogicHash(task.cmd.join(" "));

            // Check cache — dual-key: content → logic fallback
            if (this.cache) {
                const cached = this.cache.isCached(task, logicHash);
                if (cached) {
                    if (!this.options.silent) {
                        if (this.tuiReporter) {
                            this.tuiReporter.renderTaskEnd(cached);
                        } else if (this.terminalReporter) {
                            this.terminalReporter.renderTaskEnd(cached);
                        } else {
                            reportTaskEnd(cached);
                        }
                    }
                    return cached;
                }
            }

            // Execute
            const result = await runTask(task, baseEnv);

            // Build structured metadata for task_cache_v2
            const metadata = {
                telemetry: {
                    cpu_user_ms: result.durationMs * 0.8,
                    cpu_system_ms: result.durationMs * 0.2,
                    max_rss_kb: 0, // Actual RSS requires platform-specific APIs (v1.5)
                    io_wait_ms: 0,
                },
                isolation: {
                    hit_type: "MISS" as const,
                    tax_recovered_ms: 0,
                    is_flaky_candidate: false,
                },
                context: {
                    is_agent_originated: false,
                },
            };

            // Store with metadata
            if (this.cache) {
                this.cache.store(task, result, logicHash, metadata);
            }

            if (!this.options.silent) {
                if (this.tuiReporter) {
                    this.tuiReporter.renderTaskEnd(result);
                } else if (this.terminalReporter) {
                    this.terminalReporter.renderTaskEnd(result);
                } else {
                    reportTaskEnd(result);
                }
            }

            return result;
        } catch (e) {
            return {
                id: task.id,
                exitCode: 1,
                durationMs: 0,
                stdout: "",
                stderr: e instanceof Error ? e.message : String(e),
                cacheHit: false,
            };
        }
    }

    close(): void {
        this.cache?.close();
    }

    get startupMs(): number {
        return this.telemetry.engineStartupMs;
    }
}
