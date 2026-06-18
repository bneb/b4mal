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
import { S3Adapter } from "../remote/s3_adapter";
import { RemoteVault } from "./remote_vault";
import type { OrchestratorTask } from "../orchestrator/planner";
import type { TaskConfigWithId } from "../schema";

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

        // Try to infer real commands from package.json scripts
        const pkgScripts = this.readPackageScripts();

        // Convert ApertureProposals → OrchestratorTask[] for the lockfile.
        // When a task id matches a package.json script name, use that script
        // as the command instead of a placeholder echo.
        const tasks: OrchestratorTask[] = proposals.map(p => ({
            id: p.id,
            cmd: pkgScripts[p.id]
              ? [pkgScripts[p.id]]
              : ["echo", `[TODO] Define command for ${p.id} in b4mal.config.json`],
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

    /**
     * Normalize raw lockfile JSON (old flat array or new envelope format)
     * into a unified TaskConfigWithId array with canonical field names.
     */
    private normalizeLockTasks(raw: any): TaskConfigWithId[] {
      let entries: any[];
      if (Array.isArray(raw)) {
        entries = raw;
      } else {
        entries = raw.tasks ?? [];
      }

      return entries.map((t: any) => ({
        id: String(t.id ?? ""),
        cmd: t.cmd ?? [],
        dependencies: t.deps ?? t.dependencies ?? [],
        inputs: t.reads ?? t.inputs ?? [],
        outputs: t.writes ?? t.outputs ?? [],
        claims: t.claims ?? [],
        needsEnv: t.envReads ?? t.needsEnv ?? [],
        providesEnv: t.envWrites ?? t.providesEnv ?? [],
        secrets: t.secrets ?? [],
        env: t.env ?? {},
        cwd: t.cwd,
        timeout: t.timeout ?? 300_000,
        cache: t.cache ?? true,
      }));
    }

    /**
     * Create a RemoteVault if L2 cache env vars are configured.
     * Returns null (no-op) if not configured, so builds work without L2.
     */
    private createRemoteVault(): RemoteVault | undefined {
      const bucket = process.env.B4MAL_CACHE_BUCKET;
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      const region = process.env.AWS_REGION || "us-east-1";

      if (!bucket || !accessKeyId || !secretAccessKey) return undefined;

      const endpoint = process.env.AWS_S3_ENDPOINT;
      const orgId = process.env.B4MAL_CACHE_ORG;
      const adapter = new S3Adapter({
        bucket, region, accessKeyId, secretAccessKey,
        ...(endpoint ? { endpoint } : {}),
        ...(orgId ? { orgId } : {}),
      });
      return new RemoteVault(adapter);
    }

    /**
     * Read package.json scripts if available, for smarter init defaults.
     */
    private readPackageScripts(): Record<string, string> {
      try {
        const pkgPath = join(this.projectRoot, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          return pkg.scripts ?? {};
        }
      } catch {}
      return {};
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

        const raw = JSON.parse(readFileSync(this.lockPath, "utf-8"));
        const lockTasks = this.normalizeLockTasks(raw);

        // Convert to OrchestratorTask for planner compatibility
        const tasks: OrchestratorTask[] = lockTasks.map(t => ({
          id: t.id,
          cmd: t.cmd,
          claims: [
            ...t.inputs.map((p: string) => `fs:${p}`),
            ...t.outputs.map((p: string) => `fs:${p}`),
            ...t.claims,
          ],
          deps: t.dependencies,
          reads: t.inputs,
          writes: t.outputs,
          secrets: t.secrets,
          when: t.when,
        }));

        // Build a map for executor lookup (carries secrets)
        const taskExtras = new Map<string, { secrets?: string[] }>();
        for (const t of lockTasks) {
          if (t.secrets && t.secrets.length > 0) {
            taskExtras.set(t.id, { secrets: t.secrets });
          }
        }

        // Step 1: Plan waves (we need waves before verification now)
        const dag = WavePlanner.planDAG(tasks);
        const waves = dag.waves;

        // Step 2: Formal Prefix Tree verification of EACH WAVE
        const taskMap = new Map(lockTasks.map(t => [t.id, t]));
        const allConflicts: any[] = [];

        for (const wave of waves) {
            const waveClaims = wave.taskIds.map(id => {
                const t = taskMap.get(id);
                if (!t) throw new Error(`Wave references unknown task: ${id}`);
                return {
                    id: t.id,
                    reads: t.inputs,
                    writes: t.outputs,
                    envReads: t.needsEnv,
                    envWrites: t.providesEnv,
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

        // Step 3: Build remote vault from env (if configured)
        const remoteVault = this.createRemoteVault();

        // Step 4: Execute (handles L2→L1 cache waterfall, EnvSanitizer, ArtifactVault)
        const results = await DynamicExecutor.run(dag, {
            projectRoot: this.projectRoot,
            chaos: this.options.chaos,
            concurrency: this.options.concurrency,
            force: this.options.force,
            remoteVault,
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

        const raw = JSON.parse(readFileSync(this.lockPath, "utf-8"));
        const lockTasks = this.normalizeLockTasks(raw);

        const claims = lockTasks.map(t => ({
            id: t.id,
            reads: t.inputs,
            writes: t.outputs,
            envReads: t.needsEnv,
            envWrites: t.providesEnv,
        }));

        const deps = new Map<string, string[]>();
        for (const t of lockTasks) deps.set(t.id, t.dependencies);

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

        const raw = JSON.parse(readFileSync(this.lockPath, "utf-8"));
        const lockTasks = this.normalizeLockTasks(raw);

        // Convert to OrchestratorTask for planner compatibility
        const tasks: OrchestratorTask[] = lockTasks.map(t => ({
          id: t.id,
          cmd: t.cmd,
          claims: [...t.inputs.map((p: string) => `fs:${p}`), ...t.outputs.map((p: string) => `fs:${p}`), ...t.claims],
          deps: t.dependencies,
          reads: t.inputs,
          writes: t.outputs,
        }));

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
