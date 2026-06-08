/**
 * @file engine.ts
 * @description The primary coordinator connecting the DAG planner, executors, and cache vaults.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ImportTracer } from "../discovery/graph";
import { ClusterEngine } from "../discovery/auto_map";
import { WavePlanner } from "../orchestrator/planner";
import { DynamicExecutor, type WaveResult } from "../orchestrator/executor";
import { FormalShadow } from "../core/formal_shadow";
import { SQLiteLedger } from "./sqlite_ledger";
import { ArtifactVault } from "./artifact_vault";
import type { OrchestratorTask } from "../orchestrator/planner";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BuildResult {
    success: boolean;
    verified: boolean;
    conflicts: any[];
    results: WaveResult[];
}

export interface EngineOptions {
    force?: boolean;
    debug?: boolean;
    dbPath?: string;
    concurrency?: number;
    chaos?: boolean;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class B4malEngine {
    private ledger: SQLiteLedger;
    readonly projectRoot: string;
    private readonly lockPath: string;
    private readonly dbPath: string;
    private readonly options: EngineOptions;

    constructor(
        projectRoot: string = process.cwd(),
        options: EngineOptions = {},
    ) {
        this.projectRoot = projectRoot;
        this.options = options;
        this.lockPath = join(projectRoot, "b4mal.lock");

        // Respect env override for test isolation, default to LOCAL cache
        this.dbPath = options.dbPath
            ?? process.env.B4MAL_DB_PATH
            ?? join(projectRoot, ".b4mal", "cache.db");

        this.ledger = new SQLiteLedger(this.dbPath);
    }

    // ── init ──────────────────────────────────────────────────────────────────

    /**
     * Discover source files, run Tarjan's SCC via ClusterEngine, and
     * write the resulting aperture proposals to b4mal.lock as an array
     * of OrchestratorTask descriptors.
     */
    async init(migratedTasks?: OrchestratorTask[]): Promise<void> {
        if (migratedTasks && migratedTasks.length > 0) {
            writeFileSync(this.lockPath, JSON.stringify(migratedTasks, null, 2), "utf-8");
            return;
        }

        const tracer = new ImportTracer();
        const graph = await tracer.trace(this.projectRoot);
        const clusterEngine = new ClusterEngine();
        const proposals = clusterEngine.analyze(graph);

        // Convert ApertureProposals → OrchestratorTask[] for the lockfile.
        // Auto-accept high-confidence proposals (>= 0.5). Each proposal
        // becomes a task whose cmd is a no-op placeholder (populated by
        // the user or the Interview UI in production).
        const tasks: OrchestratorTask[] = proposals.map(p => ({
            id: p.id,
            cmd: ["echo", p.id],   // Placeholder command — user fills these in
            claims: p.claims,
            deps: [],
            reads:  p.claims.filter(c => c.startsWith("fs:")).map(c => c.slice(3)),
            writes: p.type === "isolated" || p.type === "combined"
                ? p.claims.filter(c => c.startsWith("fs:")).map(c => c.slice(3))
                : [],
            envReads: [],
            envWrites: [],
        }));

        writeFileSync(this.lockPath, JSON.stringify(tasks, null, 2), "utf-8");
    }

    // ── build ─────────────────────────────────────────────────────────────────

    /**
     * Parse b4mal.lock, formally verify the DAG via FormalShadow,
     * then execute each wave using the WaveExecutor (L1/L2 cache waterfall).
     *
     * Returns false (exit 1) if:
     *   - FormalShadow rejects the DAG (resource collision)
     *   - Any task exits non-zero
     */
    async build(options: EngineOptions = {}): Promise<BuildResult> {
        if (!existsSync(this.lockPath)) {
            throw new Error(
                `No b4mal.lock found. Run 'b4mal init' first. (Looked for: ${this.lockPath})`
            );
        }

        const tasks: OrchestratorTask[] = JSON.parse(
            readFileSync(this.lockPath, "utf-8")
        );

        // Step 1: Plan waves (we need waves before verification now)
        const dag = WavePlanner.planDAG(tasks);
        const waves = dag.waves;

        // Step 2: Formal Prefix Tree verification of EACH WAVE
        const taskMap = new Map(tasks.map(t => [t.id, t]));
        const allConflicts: any[] = [];

        for (const wave of waves) {
            const waveClaims = wave.taskIds.map(id => {
                const t = taskMap.get(id)!;
                return {
                    id: t.id,
                    reads: (t as any).reads ?? [],
                    writes: (t as any).writes ?? [],
                    envReads: (t as any).envReads ?? [],
                    envWrites: (t as any).envWrites ?? [],
                };
            });

            const verification = await FormalShadow.verifyWave(waveClaims);
            if (!verification.verified) {
                allConflicts.push(...verification.conflicts);
            }
        }

        if (allConflicts.length > 0) {
            return {
                success: false,
                verified: false,
                conflicts: allConflicts,
                results: [],
            };
        }

        // Step 3: Execute (handles L1/L2 cache, EnvSanitizer, ArtifactVault)
        const results = await DynamicExecutor.run(dag, {
            projectRoot: this.projectRoot,
            chaos: this.options.chaos,
        });

        const success = results.every(r => r.exitCode === 0);

        return { success, verified: true, conflicts: [], results };
    }

    /**
     * Audit the DAG for "Shadowing" — deterministic overwrites.
     */
    async shadow(): Promise<any[]> {
        if (!existsSync(this.lockPath)) {
            throw new Error(`No b4mal.lock found.`);
        }

        const tasks: OrchestratorTask[] = JSON.parse(
            readFileSync(this.lockPath, "utf-8")
        );

        const claims = tasks.map(t => ({
            id: t.id,
            reads: (t as any).reads ?? [],
            writes: (t as any).writes ?? [],
            envReads: (t as any).envReads ?? [],
            envWrites: (t as any).envWrites ?? [],
        }));

        const deps = new Map<string, string[]>();
        for (const t of tasks) deps.set(t.id, t.deps);

        return await FormalShadow.detectShadowing(claims, deps);
    }

    // ── analyze ───────────────────────────────────────────────────────────────

    /**
     * Parse b4mal.lock, plan the DAG, and inject the topology into a visual dashboard.
     */
    async analyze(): Promise<string> {
        if (!existsSync(this.lockPath)) {
            throw new Error(`No b4mal.lock found. Run 'b4mal init' first.`);
        }

        const tasks: OrchestratorTask[] = JSON.parse(
            readFileSync(this.lockPath, "utf-8")
        );

        const dag = WavePlanner.planDAG(tasks);
        
        const payload = JSON.stringify({
            waves: dag.waves,
            totalTasks: tasks.length
        }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

        const templatePath = join(__dirname, "..", "cli", "templates", "dashboard.html");
        let html = readFileSync(templatePath, "utf-8");
        html = html.replace(
            "// DATA_INJECTION_TARGET\n        const b4malData = {};",
            `const b4malData = ${payload};`
        );

        const outPath = join(this.projectRoot, "b4mal-report.html");
        writeFileSync(outPath, html, "utf-8");
        return outPath;
    }

    // ── clean ─────────────────────────────────────────────────────────────────

    /**
     * Drop all ledger entries and purge every artifact archive from
     * ~/.b4mal/artifacts/.
     */
    async clean(): Promise<void> {
        this.ledger.clear();
        await ArtifactVault.purgeAll(this.projectRoot);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Close the ledger connection. Call this after the engine is done.
     */
    close(): void {
        try { this.ledger.close(); } catch { /* already closed */ }
    }
}
