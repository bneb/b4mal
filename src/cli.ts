#!/usr/bin/env bun
/**
 * B4mal v1.0 — CLI Entry Point
 *
 * Zero YAML. Config files are TypeScript modules.
 * Usage:
 *   b4mal run <config.ts> [--dry-run] [--no-cache] [--concurrency <n>] [--jpl] [--tui]
 *   b4mal audit [--days <n>]
 */
import { PipelineSchema } from "./schema";
import { Engine } from "./engine";
import { reportError, reportValidationErrors } from "./reporter";
import { CoreAudit } from "./core/audit";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";

// ─── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
    const args = argv.slice(2);

    let command: string | undefined;
    let configPath: string | undefined;
    let dryRun = false;
    let noCache = false;
    let jpl = false;
    let tui = false;
    let concurrency = 0;
    let days = 30;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "--no-cache") {
            noCache = true;
        } else if (arg === "--jpl") {
            jpl = true;
        } else if (arg === "--tui") {
            tui = true;
        } else if (arg === "--concurrency" || arg === "-c") {
            const next = args[++i];
            if (!next || isNaN(parseInt(next))) {
                reportError("--concurrency requires a numeric argument");
                process.exit(1);
            }
            concurrency = parseInt(next);
        } else if (arg === "--days" || arg === "-d") {
            const next = args[++i];
            if (!next || isNaN(parseInt(next))) {
                reportError("--days requires a numeric argument");
                process.exit(1);
            }
            days = parseInt(next);
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        } else if (arg === "--version" || arg === "-v") {
            console.log("b4mal v1.0.0");
            process.exit(0);
        } else if (!command) {
            command = arg;
        } else if (!configPath) {
            configPath = arg;
        }
    }

    return { command, configPath, dryRun, noCache, jpl, tui, concurrency, days };
}

function printUsage(): void {
    console.log(`
  Usage: b4mal <command> [options]

  Commands:
    run <config.ts>    Execute a pipeline from a TypeScript config
    audit              Show 30-day Core Audit report
    ingest             Auto-ingest a project into b4mal.ts

  Run Options:
    --dry-run          Print the DAG without executing
    --no-cache         Skip cache lookups
    --verbose          Enable verbose dashboard
    --tui              Enable real-time TUI dashboard
    -c, --concurrency  Max parallel tasks (0 = unlimited)

  Audit Options:
    -d, --days         Window size in days (default: 30)

  General:
    -v, --version      Print version
    -h, --help         Print this help

  Configuration:
    Config files are TypeScript modules that export a pipeline object.
    No YAML. No DSL. Just types.

  Example:
    b4mal run ./pipeline.ts
    b4mal run ./pipeline.ts --jpl --no-cache
    b4mal audit
    b4mal audit --days 7
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const { command, configPath, dryRun, noCache, jpl, tui, concurrency, days } = parseArgs(
        process.argv
    );

    if (!command) {
        printUsage();
        process.exit(1);
    }

    // ── Audit Command ─────────────────────────────────────────────────────────
    if (command === "audit") {
        const dbPath = ".b4mal/cache.db";
        if (!existsSync(dbPath)) {
            reportError("No state database found. Run a pipeline first.");
            process.exit(1);
        }
        const db = new Database(dbPath, { readonly: true });
        try {
            const audit = new CoreAudit(db);
            const report = audit.generateReport(days);
            audit.printReport(report);
        } finally {
            db.close();
        }
        process.exit(0);
    }

    // ── Attest Command (v1.3.0 Rust Shim) ─────────────────────────────────────
    if (command === "attest") {
        const { AttestHandler } = await import("./cli/attest");
        const restArgs = process.argv.slice(3); // remove node, cli.js, attest

        // Convert process.env to Record<string, string | undefined>
        const env: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(process.env)) {
            env[k] = v;
        }

        const result = await AttestHandler.execute(restArgs, env);
        if (!result.accepted && !dryRun) { // Silent degradation unless dryRun/debug
            process.exit(0);
        }
        process.exit(0);
    }

    // ── Report Command ────────────────────────────────────────────────────────
    if (command === "report") {
        const auditStr = process.argv.indexOf("--audit");
        const buildTimeStr = process.argv.indexOf("--build-time");

        if (auditStr === -1) {
            reportError("Missing --audit <json_path>");
            process.exit(1);
        }

        const auditPath = process.argv[auditStr + 1];
        const buildTime = buildTimeStr !== -1 ? parseFloat(process.argv[buildTimeStr + 1]) : 8;

        try {
            const raw = Bun.file(auditPath);
            if (!(await raw.exists())) {
                reportError(`Audit file not found: ${auditPath}`);
                process.exit(1);
            }
            const auditData = await raw.json();

            const { TimeSavingsCalculator } = await import("./core/time_savings");
            const { ProposalTemplate } = await import("./reporter/proposal_template");

            const savings = TimeSavingsCalculator.calculate({
                taxEvents: auditData.taxEvents,
                avgBuildMinutes: buildTime,
            });

            const repoName = process.cwd().split("/").pop() || "Repository";
            const report = ProposalTemplate.generate(repoName, auditData, savings);

            await Bun.write("optimization_report.md", report);
            console.log(`\n\x1b[32m[OK]\x1b[0m Generated optimization report: \x1b[1moptimization_report.md\x1b[0m`);
            console.log(`  Target:  ${repoName}`);
            console.log(`  Efficiency Gain: ${savings.efficiencyGain}\n`);

        } catch (e) {
            reportError(`Failed to generate report: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
        }
        process.exit(0);
    }



    // ── Init Command ──────────────────────────────────────────────────────────
    if (command === "init") {
        const { InitCommand } = await import("./cli/init");
        await InitCommand.execute(process.argv.slice(3));
        process.exit(0);
    }

    // ── Welcome Command ───────────────────────────────────────────────────────
    if (command === "welcome") {
        const { WelcomeCommand } = await import("./cli/welcome");
        await WelcomeCommand.execute();
        process.exit(0);
    }

    // ── Ingest Command ────────────────────────────────────────────────────────
    if (command === "ingest") {
        const { TurboIngester } = await import("./discovery/turbo_ingester");
        const { PythonIngester } = await import("./discovery/python_ingester");
        const { GoIngester } = await import("./discovery/go_ingester");

        try {
            let pipeline: any = null;
            let type = "";

            const python = new PythonIngester();
            const pyPipe = python.ingest(process.cwd());
            if (pyPipe) {
                pipeline = pyPipe;
                type = "Python";
            }

            if (!pipeline) {
                const go = new GoIngester();
                const goPipe = go.ingest(process.cwd());
                if (goPipe) {
                    pipeline = goPipe;
                    type = "Go";
                }
            }

            if (!pipeline) {
                const turbo = new TurboIngester();
                pipeline = turbo.ingest(process.cwd());
                type = "Turborepo";
            }

            const outPath = `${process.cwd()}/b4mal.ts`;
            
            // We write a valid TS module
            const content = `// Auto-generated by b4mal ingest
import type { Pipeline } from "./src/schema";

export default ${JSON.stringify(pipeline, null, 4)} as Pipeline;
`;
            await Bun.write(outPath, content);
            console.log(`\n\x1b[32m✔\x1b[0m Ingested ${type} project into: \x1b[1mb4mal.ts\x1b[0m\n`);
            process.exit(0);
        } catch (e) {
            reportError(`Ingestion failed: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
        }
    }



    // ── Run Command ───────────────────────────────────────────────────────────
    if (command !== "run") {
        reportError(`Unknown command: "${command}". Use "b4mal run <config.ts>", "b4mal audit", "b4mal attest", "b4mal report", "b4mal init", "b4mal ingest" or "b4mal welcome".`);
        process.exit(1);
    }

    if (!configPath) {
        reportError('Missing config path. Usage: b4mal run <config.ts>');
        process.exit(1);
    }

    // ── Import config ─────────────────────────────────────────────────────────
    let rawConfig: unknown;
    try {
        const configModule = await import(
            configPath.startsWith("/") ? configPath : `${process.cwd()}/${configPath}`
        );
        rawConfig = configModule.default ?? configModule;
    } catch (err) {
        reportError(
            `Failed to import config "${configPath}": ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    const parsed = PipelineSchema.safeParse(rawConfig);
    if (!parsed.success) {
        const errors = parsed.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
        );
        reportValidationErrors(errors);
        process.exit(1);
    }

    const pipeline = parsed.data;

    // ── Execute ───────────────────────────────────────────────────────────────
    const engine = new Engine({ dryRun, noCache, jpl, tui, concurrency });

    try {
        const result = await engine.execute(pipeline);
        process.exit(result.success ? 0 : 1);
    } finally {
        engine.close();
    }
}

main().catch((err) => {
    reportError(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
