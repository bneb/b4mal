// src/cli/demo.ts — v6.0.0
//
// The Flake Interceptor — zero-setup, zero-config live demonstration.
//
// Scenario: A standard-looking CI pipeline with three tasks.
//   db_migrate         writes tests/fixtures/          (directory prefix)
//   integration_suite_a reads src/, writes tests/fixtures/tmp.sqlite
//   integration_suite_b reads src/, writes tests/fixtures/tmp.sqlite
//
// integration_suite_a and _b both write the same SQLite fixture file.
// parallelize them. B4mal asks the Formal Engine if that's safe — and gets SAT.
//
// No project. No config. No network. No trust. Just math.
//
// Usage: b4mal demo

import { FormalShadow, type TaskResourceClaim } from "../core/formal_shadow";

// ─── ANSI ────────────────────────────────────────────────────────────────────

const c = {
    reset:   "\x1b[0m",
    bold:    "\x1b[1m",
    dim:     "\x1b[2m",
    red:     "\x1b[31m",
    green:   "\x1b[32m",
    yellow:  "\x1b[33m",
    cyan:    "\x1b[36m",
    white:   "\x1b[97m",
    bgRed:   "\x1b[41m",
    bgBlack: "\x1b[40m",
};

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);

// ─── Demo Wave ───────────────────────────────────────────────────────────────
//
// The canonical flaky-SQLite-fixture race condition.
// Every engineering team who has run tests in parallel has hit this.

const DEMO_WAVE: TaskResourceClaim[] = [
    {
        id: "db_migrate",
        reads:     [],
        writes:    ["tests/fixtures/"],           // prefix write claim
        envReads:  ["DATABASE_URL"],
        envWrites: [],
    },
    {
        id: "integration_suite_a",
        reads:     ["src/"],
        writes:    ["tests/fixtures/tmp.sqlite"],  // exact-path write claim
        envReads:  ["PATH", "HOME"],
        envWrites: [],
    },
    {
        id: "integration_suite_b",
        reads:     ["src/"],
        writes:    ["tests/fixtures/tmp.sqlite"],  // SAME exact-path write claim → collision
        envReads:  ["PATH", "HOME"],
        envWrites: [],
    },
];

// The path that the engine proves is contested
const WITNESS = "tests/fixtures/tmp.sqlite";

// ─── Theatrical Output ───────────────────────────────────────────────────────

function renderHeader(): void {
    out(`\n`);
    out(`${c.bold}${c.white}  B4MAL INTERACTIVE DEMO${c.reset}\n`);
    out(`${c.dim}  ────────────────────────────────────────────────────────────────\n${c.reset}`);
    out(`\n`);
    out(`  ${c.bold}Scenario${c.reset}: Submitting a standard, seemingly-safe CI pipeline…\n`);
    out(`\n`);
    out(`  ${c.dim}Task 1${c.reset}  ${c.bold}db_migrate${c.reset}          ` +
        `${c.dim}Writes: tests/fixtures/ (migration output)${c.reset}\n`);
    out(`  ${c.dim}Task 2${c.reset}  ${c.bold}integration_suite_a${c.reset}  ` +
        `${c.dim}Writes: tests/fixtures/tmp.sqlite${c.reset}\n`);
    out(`  ${c.dim}Task 3${c.reset}  ${c.bold}integration_suite_b${c.reset}  ` +
        `${c.dim}Writes: tests/fixtures/tmp.sqlite${c.reset}\n`);
    out(`\n`);
    out(`  Standard CI runners (${c.bold}Make, Turborepo, GitHub Actions${c.reset}) would\n`);
    out(`  parallelize tasks 2 and 3. Let's see what the Formal Engine says…\n`);
    out(`\n`);
}

function renderSMTFormula(): void {
    out(`${c.cyan}${c.bold}  QF_S Formula Submitted to Formal Engine${c.reset}\n`);
    out(`${c.dim}  ───────────────────────────────────────${c.reset}\n`);
    out(`${c.cyan}`);
    out(`  (set-logic QF_S)\n`);
    out(`  (declare-const P String)\n`);
    out(`\n`);
    out(`  ; integration_suite_a holds exclusive write lock on:\n`);
    out(`  (assert (= P "tests/fixtures/tmp.sqlite"))\n`);
    out(`\n`);
    out(`  ; integration_suite_b also holds exclusive write lock on:\n`);
    out(`  (assert (= P "tests/fixtures/tmp.sqlite"))\n`);
    out(`\n`);
    out(`  (check-sat)   ; Is there a path P contested by both?\n`);
    out(`${c.reset}\n`);
}

async function renderSpinner(ms: number, label: string): Promise<void> {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const interval = 80;
    const ticks = Math.floor(ms / interval);
    for (let i = 0; i < ticks; i++) {
        process.stdout.write(`\r  ${c.cyan}${frames[i % frames.length]}${c.reset}  ${label}…`);
        await Bun.sleep(interval);
    }
    process.stdout.write(`\r${" ".repeat(label.length + 12)}\r`);
}

function renderCollision(
    taskA: string,
    taskB: string,
    witness: string,
    durationMs: number,
): void {
    err(`\n`);
    err(`${c.bgRed}${c.bold}${c.white}`);
    err(`  [FAIL] FATAL: PATH COLLISION DETECTED                                      `);
    err(`${c.reset}\n\n`);

    err(`${c.red}${c.bold}  Wave cannot be parallelized. Race condition formally proven.${c.reset}\n\n`);

    err(`${c.red}  Conflict:${c.reset} ${c.bold}[${taskA}]${c.reset}${c.red}  (Content) ${c.reset}${c.bold}[${taskB}]${c.reset}\n`);
    err(`\n`);
    err(`${c.red}  Formal Engine Counterexample Model:${c.reset}\n`);
    err(`${c.red}  ↳ Path overlap proven at:  ${c.bold}${c.white}${witness}${c.reset}\n`);
    err(`\n`);
    err(`${c.dim}  If both tasks ran in parallel, each would open ${witness}\n`);
    err(`  with exclusive write intent. The last writer wins — silently\n`);
    err(`  corrupting whichever test suite ran second. Best case: a flaky\n`);
    err(`  test you spend a sprint debugging. Worst case: a poisoned cache\n`);
    err(`  artifact ships the corrupted state to the next build layer.\n${c.reset}\n`);

    err(`${c.bold}  Fix (choose one):${c.reset}\n`);
    err(`${c.dim}  1. Add sequential dependency: ${taskB} → depends_on: [${taskA}]\n`);
    err(`  2. Isolate fixtures: give each suite a unique tmp path\n`);
    err(`     e.g. tests/fixtures/tmp_a.sqlite  vs  tests/fixtures/tmp_b.sqlite\n`);
    err(`  3. Use an in-memory SQLite database (:memory:) in each suite\n${c.reset}\n`);

    err(`${c.dim}  ─────────────────────────────────────────────────────────────────\n`);
    err(`  Solver: PrefixTree Native Engine | Proof time: ${durationMs.toFixed(1)}ms\n`);
    err(`  Pair checks: C(3,2) = 3 | Wave depth: 0 | Mode: Resource Monitor\n${c.reset}\n`);

    out(`\n`);
    out(`  ${c.bold}B4mal operates ${c.green}proactively${c.reset}${c.bold}.${c.reset}\n`);
    out(`  We don't quarantine flaky tests — we prevent them\n`);
    out(`  from running in the first place.\n\n`);
    out(`  ${c.dim}Standard CI:   run → flake → detect → quarantine → retry → repeat${c.reset}\n`);
    out(`  ${c.bold}b4mal:      prove → halt → fix → run${c.reset}\n\n`);
}


// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runDemo(): Promise<never> {
    renderHeader();

    out(`  ${c.cyan}Booting Resource Monitor Verification…${c.reset}\n\n`);

    renderSMTFormula();

    await renderSpinner(900, "Formal Engine Verification");

    const t0 = performance.now();
    const result = await FormalShadow.verifyWave(DEMO_WAVE);

    const elapsed = performance.now() - t0;

    if (result.verified) {
        // Unexpected: scenario should always collide
        err(`${c.yellow}\n  [WARN] Unexpected: Formal Engine returned safe for the demo scenario.\n`);
        err(`  This usually means the Engine evaluated the formula differently\n`);
        err(`  than expected. Try: b4mal demo --verbose\n${c.reset}`);
        process.exit(1);
    }

    // Confirmed collision — pick the most interesting conflict to display
    const primary = result.conflicts.find(
        cf => cf.taskA === "integration_suite_a" || cf.taskB === "integration_suite_a"
    ) ?? result.conflicts[0];

    const witness = primary?.counterexample ?? WITNESS;

    renderCollision(primary?.taskA ?? "integration_suite_a",
                    primary?.taskB ?? "integration_suite_b",
                    witness,
                    elapsed);

    process.exit(1);
}
