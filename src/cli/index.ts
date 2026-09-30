#!/usr/bin/env bun
// B4mal CLI
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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { B4malEngine } from "../core/engine";
import { runDemo } from "./demo";
import { getVersion } from "./version";

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
                sync: { type: "boolean" },
                "from-config": { type: "boolean" },
                "dry-run": { type: "boolean" },
                strict: { type: "boolean" },
                version: { type: "boolean", short: "v" },
                chaos: { type: "boolean" },
                json: { type: "boolean" },
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

    if (values.version) {
        // Never throws: falls back to a compiled-in version if package.json
        // cannot be located (see src/cli/version.ts).
        process.stdout.write(`${getVersion()}\n`);
        process.exit(0);
    }

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

                // Discovery infers a graph; the config schema is stricter than the
                // lockfile ever was and rejects dangling edges and cycles. When
                // inference produced an edge that does not survive, it was
                // dropped — say so rather than presenting a pruned graph as a
                // clean success.
                if (engine.prunedEdges.length > 0) {
                    warn(`${engine.prunedEdges.length} inferred dependency edge(s) were removed:`);
                    for (const e of engine.prunedEdges.slice(0, 5)) {
                        info(`   ${e}`);
                    }
                    if (engine.prunedEdges.length > 5) {
                        info(`   …and ${engine.prunedEdges.length - 5} more`);
                    }
                    info("Add these back in b4mal.config.json if they are real dependencies.");
                }

                // Report what was actually written rather than assuming. init can
                // legitimately discover nothing (empty project, unrecognised
                // layout), and telling the user to "edit the cmd arrays" when the
                // lock contains no tasks is worse than saying so. Likewise, only
                // warn about placeholders when the lock really contains some —
                // migrated tasks carry real commands.
                const lockPath = join(engine.projectRoot, "b4mal.lock");

                let discovered = 0;
                let placeholders = 0;
                try {
                    const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
                    const entries = Array.isArray(raw) ? raw : raw.tasks ?? [];
                    discovered = entries.length;
                    // Match the placeholder init actually writes, not merely a
                    // command that happens to start with `echo`.
                    placeholders = entries.filter((t: any) => {
                        const cmd = t.cmd ?? [];
                        return cmd[0] === "echo" && cmd.join(" ").includes("No command found for");
                    }).length;
                } catch {
                    // Unreadable lock is reported by `b4mal build`; nothing to add here.
                }

                if (discovered === 0) {
                    warn("Discovery found no tasks — b4mal.lock is empty.");
                    info("Define your tasks in b4mal.config.json, then run: b4mal build");
                } else if (placeholders > 0) {
                    // Checked before the config branch: init now always writes a
                    // config, so keying "is there a config" first hid the
                    // placeholder warning entirely — a config full of stubs would
                    // have been reported as a clean success.
                    ok(`b4mal.config.json + b4mal.lock generated — ${discovered} task(s).`);
                    warn(
                        `${placeholders} of ${discovered} task(s) have placeholder commands and will not build anything.`
                    );
                    info("Declare real commands in b4mal.config.json, then run: b4mal build");
                } else {
                    ok(`b4mal.config.json + b4mal.lock generated — ${discovered} task(s), all with real commands.`);
                    info("b4mal.lock is generated from b4mal.config.json, so edit the config, not the lock.");
                    info("Then run: b4mal build");
                }
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
                    process.exit(1);
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
                await syncLockFromConfig(process.cwd(), values.sync || values["from-config"]);

                const dryRun = values["dry-run"];
                const opts = { force: values.force, strict: values.strict };

                if (dryRun) {
                  const plan = await engine.plan();
                  banner(`Dry Run — ${plan.waves.length} waves, ${plan.totalTasks} tasks`);
                  for (const wave of plan.waves) {
                    process.stdout.write(`\n  ${c.dim}wave ${wave.depth}${c.reset} ${c.dim}(${wave.taskIds.length} tasks)${c.reset}\n`);
                    for (const id of wave.taskIds) process.stdout.write(`    ${id}\n`);
                  }
                  if (plan.conflicts.length > 0) {
                    process.stdout.write(`\n  ${c.red}${plan.conflicts.length} collision(s) detected:${c.reset}\n`);
                    for (const conflict of plan.conflicts) {
                      process.stdout.write(`    ${c.red}${conflict.taskA} ↔ ${conflict.taskB}: ${conflict.resource}${c.reset}\n`);
                    }
                  }
                  process.exit(0);
                }

                const result = await engine.build(opts);

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

                // Summary. Tasks skipped by their own `when` condition are
                // excluded from both counts: they were neither restored nor
                // executed, and reporting them as either is misleading.
                const conditionSkipped = result.results.filter(r => r.skippedByCondition).length;
                const hits   = result.results.filter(r => r.cached && !r.skippedByCondition).length;
                const misses = result.results.filter(r => !r.cached && !r.skippedByCondition).length;

                for (const r of result.results) {
                    if (r.cached && !r.skippedByCondition) {
                        process.stdout.write(`${c.cyan}${c.dim}   ↩ ${r.taskId} (cached)${c.reset}\n`);
                    } else if (r.skippedByCondition) {
                        process.stdout.write(`${c.dim}   ⊘ ${r.taskId} (skipped — when condition not met)${c.reset}\n`);
                    } else if (r.skipped) {
                        process.stdout.write(`${c.yellow}   ⊘ ${r.taskId} (skipped — dependency failed)${c.reset}\n`);
                    } else if (r.exitCode !== 0) {
                        process.stderr.write(`${c.red}   ✗ ${r.taskId}  [exit ${r.exitCode}]${c.reset}\n`);
                        if (r.stderr) process.stderr.write(`${c.dim}${r.stderr}${c.reset}\n`);
                        if (r.stdout) process.stderr.write(`${c.dim}${r.stdout}${c.reset}\n`);
                    } else {
                        process.stdout.write(`${c.green}${c.bold}   [OK] ${r.taskId}${c.reset}  ${r.durationMs}ms\n`);
                    }
                }

                if (hits > 0) {
                    const skippedNote = conditionSkipped > 0 ? `, ${conditionSkipped} skipped by condition` : "";
                    info(`${hits} task(s) restored from cache — ${misses} executed${skippedNote}.`);
                } else if (conditionSkipped > 0) {
                    info(`${conditionSkipped} task(s) skipped by condition — ${misses} executed.`);
                }

                if (!result.success) {
                    const skippedCount = result.results.filter(r => r.skipped).length;
                    fail(skippedCount > 0
                        ? `One or more tasks failed — ${skippedCount} downstream task(s) skipped.`
                        : "One or more tasks exited non-zero.");

                    process.exit(1);
                }

                ok(`Build complete. ${result.results.length} tasks, ${hits} cache hits.`);
                process.exit(0);
            }

            // ── remote ──────────────────────────────────────────────────────
            case "remote": {
                const { RemoteCommand } = await import("./remote");
                await RemoteCommand.execute(positionals.slice(3));
                break;
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

            // ── check ────────────────────────────────────────────────────────
            case "check": {
                const jsonMode = values.json;
                const isGHA = process.env.GITHUB_ACTIONS === "true";

                // Compile the lockfile from the config first, exactly as build
                // does, so `check` verifies what the user actually edited rather
                // than a stale or absent lockfile.
                await syncLockFromConfig(process.cwd(), false);

                if (!jsonMode) {
                    banner("Verifying DAG Correctness…");
                    info("Checking resource isolation and shadowing without executing tasks.");
                }

                const plan = await engine.plan();
                let issues = plan.conflicts.length;
                const findings: any[] = [];

                for (const conflict of plan.conflicts) {
                    findings.push({
                        type: "collision",
                        severity: "error",
                        taskA: conflict.taskA,
                        taskB: conflict.taskB,
                        resource: conflict.resource,
                        message: `Collision: ${conflict.taskA} ↔ ${conflict.taskB} on ${conflict.resource}`,
                        help: "https://github.com/bneb/b4mal/blob/main/docs/concepts/resource-isolation.md",
                    });
                }

                const shadows = await engine.shadow();
                issues += shadows.length;
                for (const s of shadows) {
                    const isImplicitDep = s.kind === "implicit-dependency";
                    findings.push({
                        type: isImplicitDep ? "implicit-dependency" : "shadow",
                        severity: "warning",
                        upstream: s.taskA,
                        downstream: s.taskB,
                        resource: s.resources?.[0] ?? s.counterexample,
                        ordering: s.ordering,
                        message: s.counterexample ?? `Shadow: ${s.taskB} masks ${s.taskA}`,
                        help: "https://github.com/bneb/b4mal/blob/main/docs/concepts/resource-isolation.md#shadowing-detection",
                    });
                }

                if (jsonMode) {
                    process.stdout.write(JSON.stringify({
                        verified: issues === 0,
                        taskCount: plan.totalTasks,
                        collisions: plan.conflicts.length,
                        shadows: shadows.length,
                        // Reported so tooling can tell "checked and clean" from
                        // "nothing to check". An empty DAG verifies vacuously,
                        // and calling that verified without saying so is the kind
                        // of assurance this command exists to avoid giving.
                        note: plan.totalTasks === 0
                            ? "no tasks in the lockfile — nothing was verified"
                            : undefined,
                        findings,
                    }, null, 2) + "\n");
                } else if (isGHA) {
                    // GitHub Actions workflow commands for PR annotations
                    for (const f of findings) {
                        const cmd = f.severity === "error" ? "error" : "warning";
                        process.stdout.write(`::${cmd}::${f.message}\n`);
                    }
                    if (issues === 0) {
                        process.stdout.write(plan.totalTasks === 0
                            ? `::warning::b4mal check found no tasks in b4mal.lock — nothing was verified.\n`
                            : `::notice::DAG verified — no collisions, no shadowing.\n`);
                    }
                } else {
                    for (const f of findings) {
                        if (f.type === "collision") {
                            process.stdout.write(
                                `   ${c.red}Collision${c.reset}: ${c.bold}${f.taskA}${c.reset} ↔ ${c.bold}${f.taskB}${c.reset} on ${c.dim}${f.resource}${c.reset}\n`
                            );
                        } else if (f.type === "implicit-dependency") {
                            process.stdout.write(
                                `   ${c.yellow}Implicit dependency${c.reset}: ${c.bold}${f.downstream}${c.reset} reads ${c.dim}${f.resource}${c.reset} produced by ${c.bold}${f.upstream}${c.reset} with no declared edge\n`
                            );
                        } else {
                            const note = f.ordering === "implicit"
                                ? `${c.dim} (no declared dependency — ordering synthesized by the planner)${c.reset}`
                                : "";
                            process.stdout.write(
                                `   ${c.yellow}Shadow${c.reset}: ${c.bold}${f.downstream}${c.reset} masks ${c.bold}${f.upstream}${c.reset} on ${c.dim}${f.resource}${c.reset}${note}\n`
                            );
                        }
                    }
                    if (issues > 0) {
                        process.stdout.write(`\n   ${c.red}${issues} issue(s) found.${c.reset}\n`);
                        process.stdout.write(`   ${c.dim}Docs: https://github.com/bneb/b4mal/blob/main/docs/concepts/resource-isolation.md${c.reset}\n`);
                        process.stdout.write(`   ${c.dim}Run 'b4mal build' to execute after fixing the above.${c.reset}\n\n`);
                    } else if (plan.totalTasks === 0) {
                        // Not "verified": an empty DAG verifies vacuously, and
                        // reporting that as success hides a lockfile that is empty
                        // because generation went wrong.
                        warn("b4mal.lock contains no tasks — nothing was verified.");
                        info("Declare tasks in b4mal.config.json, then run: b4mal build --sync");
                    } else {
                        ok("DAG verified — no collisions, no shadowing.");
                    }
                }

                if (issues > 0) process.exit(1);
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
                        if (s.kind === "implicit-dependency") {
                            process.stdout.write(
                                `   ${c.yellow} (Implicit) ${s.taskB}${c.reset} reads output of ${c.bold}${s.taskA}${c.reset} on: ${c.dim}${s.resources?.[0] ?? s.counterexample}${c.reset}\n`
                            );
                            continue;
                        }
                        const note = s.ordering === "implicit" ? `${c.dim} [no declared dependency]${c.reset}` : "";
                        process.stdout.write(
                            `   ${c.yellow} (Content) ${s.taskB}${c.reset} masks ${c.bold}${s.taskA}${c.reset} on: ${c.dim}${s.resources?.[0] ?? s.counterexample}${c.reset}${note}\n`
                        );
                    }
                    process.stdout.write(`\n   ${c.dim}Shadowing is deterministic in a standard DAG, but it may indicate\n`);
                    process.stdout.write(`   unintentional work masking or inefficient task granularity.\n${c.reset}`);
                }
                break;
            }

            // ── attest ────────────────────────────────────────────────────────
            // Machine-facing shim: a build script (the Rust crate included)
            // declares the resources it will touch and gets back a normalized
            // claim. JSON on stdout so callers can parse it; exit 1 when the
            // declaration is unusable.
            case "attest": {
                const { AttestHandler } = await import("./attest");
                const result = await AttestHandler.execute(positionals.slice(3), process.env);
                process.stdout.write(JSON.stringify(result, null, 2) + "\n");
                process.exit(result.accepted ? 0 : 1);
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
                // Args are indexed from Bun.argv, so [0] is the runtime, [1] the
                // script, [2] the command and [3] the first argument. This block
                // used [1]/[2] — the script path and the command — so every
                // subcommand fell through to "Unknown plugin command" and
                // `b4mal plugin install` could never work.
                const sub = positionals[3];
                const { WasmRegistry } = await import("../plugin/wasm_registry");
                const path = await import("path");
                const registry = new WasmRegistry();

                if (sub === "install") {
                    const url = positionals[4];
                    if (!url) {
                        fail("Usage: b4mal plugin install <url> [name]");
                        info("Example: b4mal plugin install https://example.com/my-plugin.wasm");
                        process.exit(1);
                    }

                    // Validated here so an unusable URL reads as a user error.
                    // Left to the fetch it surfaced as the runtime's own
                    // "fetch() URL is invalid", which says nothing about what to
                    // do and looked like a crash.
                    let parsedUrl: URL;
                    try {
                        parsedUrl = new URL(url);
                    } catch {
                        fail(`"${url}" is not a valid URL.`);
                        info("Expected an absolute URL, e.g. https://example.com/my-plugin.wasm");
                        process.exit(1);
                    }

                    // Derived after the guard: with no URL this used to call
                    // path.basename(undefined) and throw before the check ran.
                    //
                    // The fallback matters: a URL like `mock://demo` parses with
                    // an empty pathname, so basename alone yielded "" and
                    // installed a file literally named ".wasm". An explicit name
                    // is always accepted as the second argument.
                    const derived = path.basename(parsedUrl.pathname, ".wasm");
                    const name = positionals[5] || derived || parsedUrl.hostname || "plugin";
                    banner(`Installing Plugin: ${name}`);
                    // Download, magic-number and name failures are all expected
                    // outcomes of pointing at a URL, not internal faults.
                    try {
                        const outPath = await registry.install(url, name);
                        ok(`Plugin successfully installed to ${outPath}`);
                    } catch (err: any) {
                        fail(err?.message ?? String(err));
                        process.exit(1);
                    }
                } else if (sub === "run") {
                    const name = positionals[4];
                    if (!name) {
                        fail("Usage: b4mal plugin run <name>");
                        process.exit(1);
                    }
                    banner(`Running Plugin: ${name}`);
                    try {
                        const code = await registry.run(name);
                        ok(`Plugin exited with code ${code}`);
                    } catch (err: any) {
                        fail(err?.message ?? String(err));
                        process.exit(1);
                    }
                } else {
                    fail("Unknown plugin command. Try: install, run");
                    process.exit(1);
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
                fail(`Unknown command: "${command}". Usage: b4mal <init|check|build|shadow|migrate|clean>`);
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

// ─── Config → lockfile sync ─────────────────────────────────────────────────

/**
 * Regenerate b4mal.lock from b4mal.config.json when the config is newer (or when
 * explicitly asked).
 *
 * Shared by `build` and `check`. `check` previously skipped this and read the
 * lockfile directly, so the workflow the README documents — write a config, then
 * `b4mal check` — failed with "No b4mal.lock found" even though `build` worked
 * straight away. A verifier that cannot see the file the user edited is not
 * verifying what they think it is.
 */
async function syncLockFromConfig(projectRoot: string, force: boolean): Promise<void> {
    const configPath = join(projectRoot, "b4mal.config.json");
    if (!force && !existsSync(configPath)) return;

    const { loadConfig, configToTasks, writeLockfileAtomic, isConfigStale } = await import("../config_loader");
    if (!force && !isConfigStale(projectRoot)) return;

    // Written to stderr, not stdout. This is progress, and stdout belongs to the
    // command's actual output — with `info()` here, `b4mal check --json` emitted
    // this line before its JSON payload and no longer parsed.
    process.stderr.write(`${c.dim}   Loading b4mal.config.json...${c.reset}\n`);
    const tasks = configToTasks(loadConfig(projectRoot));
    writeLockfileAtomic(tasks, join(projectRoot, "b4mal.lock"));
    if (force) process.stderr.write(`${c.dim}   Lockfile regenerated from config (--sync).${c.reset}\n`);
}

function printUsage(): void {
    process.stdout.write(`
  ${c.bold}b4mal${c.reset} — Core Build Engine v${getVersion()}

  ${c.dim}Requires the Bun runtime (https://bun.sh). Prebuilt release binaries are
  self-contained; installing from npm still needs Bun available at runtime.${c.reset}

  ${c.bold}Usage:${c.reset}
    b4mal demo           🛑 See the engine intercept a race condition live (start here)
    b4mal init           Discover source files → b4mal.config.json + b4mal.lock
    b4mal check          Verify DAG correctness (collisions + shadowing, no execution)
    b4mal setup ci       Generate zero-configuration GitHub Actions workflow
    b4mal build          Prove + execute DAG (cache-aware)
    b4mal shadow         Audit DAG for deterministic output masking
    b4mal analyze        Generate visual observability dashboard
    b4mal migrate <yml>  Migrate RWX Mint YAML to b4mal
    b4mal clean          Purge artifact vault + ledger
    b4mal trace "cmd"    Synthesize a DAG automatically via eBPF
    b4mal plugin         Manage and execute decentralized WASM plugins
    b4mal attest         Declare a task's resources and get a normalized claim (JSON)

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

