#!/usr/bin/env bun
// B4mal v5.0.0 — The Core CLI
//
// Commands:
//   b4mal init     Discover source files and write b4mal.lock
//   b4mal build    Formally verify + execute the DAG (cache-aware)
//   b4mal clean    Purge artifact vault and SQLite ledger
//
// Flags:
//   --force, -f       Bypass cache (force re-execution of all tasks)
//   --debug, -d       Print stack traces on error
//
// Exit codes:
//   0  success
//   1  build failure, verification rejection, or fatal error
//
// Unhandled rejections are caught globally — a build tool never exits 0 on crash.

import { parseArgs } from "util";
import { readFileSync, writeFileSync } from "fs";
import { B4malEngine } from "../core/engine";
import { runDemo } from "./demo";

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const c = {
    reset:  "\x1b[0m",
    bold:   "\x1b[1m",
    dim:    "\x1b[2m",
    green:  "\x1b[32m",
    cyan:   "\x1b[36m",
    red:    "\x1b[31m",
    yellow: "\x1b[33m",
};

function banner(msg: string)  { process.stdout.write(`\n${c.bold}${msg}${c.reset}\n`); }
function ok(msg: string)      { process.stdout.write(`${c.green}[OK] ${msg}${c.reset}\n`); }
function fail(msg: string)    { process.stderr.write(`${c.red}[FAIL] ${msg}${c.reset}\n`); }
function info(msg: string)    { process.stdout.write(`${c.dim}   ${msg}${c.reset}\n`); }
function warn(msg: string)    { process.stdout.write(`${c.yellow}[WARN] ${msg}${c.reset}\n`); }

// ─── Global error guard ──────────────────────────────────────────────────────

// A build tool must never silently exit 0 on an unhandled rejection.
process.on("unhandledRejection", (reason) => {
    fail(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exit(1);
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    let values: any;
    let positionals: string[];

    try {
        const parsed = parseArgs({
            args: Bun.argv,
            options: {
                force: { type: "boolean", short: "f", default: false },
                debug: { type: "boolean", short: "d", default: false },
                concurrency: { type: "string", short: "c" },
                chaos: { type: "boolean" },
                help: { type: "boolean", short: "h", default: false },
            },
            strict: true,
            allowPositionals: true,
        });
        values = parsed.values;
        positionals = parsed.positionals;
    } catch (e: any) {
        fail(`CLI Argument Error: ${e.message}`);
        process.exit(1);
    }

    if (values.help) {
        printUsage();
        process.exit(0);
    }

    // Bun.argv: [bun, script, command, ...rest]
    const command = positionals[2];

    if (!command) {
        printUsage();
        process.exit(1);
    }

    const engine = new B4malEngine(process.cwd(), {
        force: values.force,
        debug: values.debug,
        concurrency: values.concurrency ? parseInt(values.concurrency, 10) : undefined,
        chaos: values.chaos,
    });

    try {
        switch (command) {

            // ── demo ─────────────────────────────────────────────────────────
            case "demo": {
                await runDemo(); // always exits — never returns
                break;
            }

            // ── trace ────────────────────────────────────────────────────────
            case "trace": {
                const { TraceCommand } = await import("./trace");
                await TraceCommand.execute(positionals.slice(3));
                break;
            }

            // ── init ──────────────────────────────────────────────────────────
            case "init": {
                banner("Initializing Core Discovery…");
                const { MigrationWizard } = await import("./wizard");
                const migratedTasks = await MigrationWizard.prompt(engine.projectRoot);
                await engine.init(migratedTasks || undefined);
                ok("b4mal.lock generated.");
                info("Edit the cmd arrays in b4mal.lock, then run: b4mal build");
                break;
            }

            // ── setup ─────────────────────────────────────────────────────────
            case "setup": {
                const sub = positionals[3]; // b4mal setup <subcommand>
                if (sub === "ci" || sub === "github") {
                    const { CICommand } = await import("./ci");
                    await CICommand.execute(Bun.argv);
                } else {
                    fail("Unknown setup command. Try: b4mal setup ci");
                }
                break;
            }

            // ── lsp ───────────────────────────────────────────────────────────
            case "lsp": {
                const { startLspServer } = await import("../lsp/server");
                startLspServer();
                break;
            }

            // ── build ─────────────────────────────────────────────────────────
            case "build": {
                banner("Engaging Wave Orchestrator…");

                const result = await engine.build({ force: values.force });

                if (!result.verified) {
                    fail("Resource Monitor rejected the build DAG due to resource collisions.");
                    for (const conflict of result.conflicts) {
                        const a = conflict.taskA ?? conflict.tasks?.[0] ?? "?";
                        const b = conflict.taskB ?? conflict.tasks?.[1] ?? "?";
                        const res = conflict.conflictingResources?.join(", ") ?? "unknown";
                        process.stderr.write(
                            `${c.red}   ✗ ${a} ↔ ${b}: ${res}${c.reset}\n`
                        );
                    }
                    process.exit(1);
                }

                // Summary
                const hits   = result.results.filter(r => r.cached).length;
                const misses = result.results.filter(r => !r.cached).length;

                for (const r of result.results) {
                    if (r.cached) {
                        process.stdout.write(`${c.cyan}${c.dim}   ↩ ${r.taskId} (cached)${c.reset}\n`);
                    } else if (r.exitCode !== 0) {
                        process.stderr.write(`${c.red}   ✗ ${r.taskId}  [exit ${r.exitCode}]${c.reset}\n`);
                        if (r.stderr) process.stderr.write(`${c.dim}${r.stderr}${c.reset}\n`);
                        if (r.stdout) process.stderr.write(`${c.dim}${r.stdout}${c.reset}\n`);
                    } else {
                        process.stdout.write(`${c.green}${c.bold}   [OK] ${r.taskId}${c.reset}  ${r.durationMs}ms\n`);
                    }
                }

                if (hits > 0) info(`${hits} task(s) restored from cache — ${misses} executed.`);

                if (!result.success) {
                    fail("One or more tasks exited non-zero.");
                    
                    process.exit(1);
                }

                ok(`Build complete. ${result.results.length} tasks, ${hits} cache hits.`);
                process.exit(0);
            }

            // ── watch ────────────────────────────────────────────────────────
            case "watch":
            case "dev": {
                const { WatchCommand } = await import("./watch");
                await WatchCommand.execute(positionals.slice(3));
                break;
            }

            // ── clean ─────────────────────────────────────────────────────────
            case "clean": {
                banner("Purging Artifact Vault and SQLite Ledger…");
                await engine.clean();
                ok("Clean complete. Vault and ledger purged.");
                break;
            }

            // ── shadow ───────────────────────────────────────────────────────
            case "shadow": {
                banner("Auditing DAG for Deterministic Shadowing…");
                info("Checking if downstream tasks mask upstream outputs…");
                const shadows = await engine.shadow();

                if (shadows.length === 0) {
                    ok("No shadowing detected. Every write is unique or additive.");
                } else {
                    warn(`${shadows.length} shadowing event(s) detected.`);
                    for (const s of shadows) {
                        process.stdout.write(
                            `   ${c.yellow} (Content) ${s.taskB}${c.reset} masks ${c.bold}${s.taskA}${c.reset} on: ${c.dim}${s.counterexample}${c.reset}\n`
                        );
                    }
                    process.stdout.write(`\n   ${c.dim}Shadowing is deterministic in a standard DAG, but it may indicate\n`);
                    process.stdout.write(`   unintentional work masking or inefficient task granularity.\n${c.reset}`);
                }
                break;
            }

            // ── analyze ───────────────────────────────────────────────────────
            case "analyze": {
                banner("Generating Visual Observability Dashboard…");
                const outPath = await engine.analyze();
                ok(`Dashboard generated at: ${outPath}`);
                info("Open it in your browser to view the build graph.");
                break;
            }

            // ── plugin ────────────────────────────────────────────────────────
            case "plugin": {
                const sub = positionals[1];
                const { WasmRegistry } = await import("../plugin/wasm_registry");
                const path = await import("path");
                const registry = new WasmRegistry();
                
                if (sub === "install") {
                    const url = positionals[2];
                    const name = positionals[3] || path.basename(url, ".wasm");
                    if (!url) {
                        fail("Usage: b4mal plugin install <url> [name]");
                        process.exit(1);
                    }
                    banner(`Installing Plugin: ${name}`);
                    const outPath = await registry.install(url, name);
                    ok(`Plugin successfully installed to ${outPath}`);
                } else if (sub === "run") {
                    const name = positionals[2];
                    if (!name) {
                        fail("Usage: b4mal plugin run <name>");
                        process.exit(1);
                    }
                    banner(`Running Plugin: ${name}`);
                    const code = await registry.run(name);
                    ok(`Plugin exited with code ${code}`);
                } else {
                    fail("Unknown plugin command. Try: install, run");
                }
                break;
            }

            // ── migrate ─────────────────────────────────────────────────────
            case "migrate": {
                const yamlPath = positionals[3];
                if (!yamlPath) {
                    fail("Missing RWX Mint YAML path. Usage: b4mal migrate <mint.yml>");
                    process.exit(1);
                }

                banner("Migrating RWX Mint → Core b4mal…");
                const { MintTranspiler } = await import("../shim/mint_transpiler");
                const yaml = readFileSync(yamlPath, "utf-8");
                const result = MintTranspiler.transpile(yaml);

                const outPath = `${result.pipeline.name || "pipeline"}.ts`;
                writeFileSync(outPath, result.typescript);

                ok(`Migrated ${result.pipeline.tasks.length} tasks to ${outPath}`);
                for (const w of result.warnings) warn(w);

                info(`Forecast: ${result.forecast.estimatedTaxRecovery.toFixed(0)}ms potentially saved via b4mal caching.`);
                break;
            }

            // ── unknown ───────────────────────────────────────────────────────
            default: {
                fail(`Unknown command: "${command}". Usage: b4mal <init|build|shadow|migrate|clean>`);
                printUsage();
                process.exit(1);
            }
        }

    } catch (error: any) {
        fail(`FATAL: ${error.message}`);
        if (values.debug) {
            process.stderr.write(`\n${c.dim}${error.stack}${c.reset}\n`);
        }
        process.exit(1);
    } finally {
        engine.close();
    }
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function printUsage(): void {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    process.stdout.write(`
  ${c.bold}b4mal${c.reset} — Core Build Engine v${pkg.version}

  ${c.bold}Usage:${c.reset}
    b4mal demo           🛑 See the engine intercept a race condition live (start here)
    b4mal init           Discover source files → b4mal.lock
    b4mal setup ci       Generate zero-configuration GitHub Actions workflow
    b4mal build          Prove + execute DAG (cache-aware)
    b4mal shadow         Audit DAG for deterministic output masking
    b4mal analyze        Generate visual observability dashboard
    b4mal migrate <yml>  Migrate RWX Mint YAML to b4mal
    b4mal clean          Purge artifact vault + ledger
    b4mal trace "cmd"    Synthesize a DAG automatically via eBPF
    b4mal plugin         Manage and execute decentralized WASM plugins

  ${c.bold}Flags:${c.reset}
    -f, --force             Bypass cache (force re-execution)
    -d, --debug             Verbose logging output
    -c, --concurrency <n>   Max parallel execution limit
    --chaos                 Shuffle execution to find hidden dependencies

  ${c.bold}Exit Codes:${c.reset}
    0  Success
    1  Build failure, collision, or fatal error
\n`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main();

console.log('hi');
