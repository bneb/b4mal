/**
 * B4mal v1.0 — Terminal Reporter
 *
 * High-intensity ANSI terminal dashboard. Zero dependencies.
 * Renders: Isolation HUD, Wave Visualization, Metabolic Profile, Flight Summary.
 */
import type { TaskResult, PipelineResult } from "./schema";
import type { TaxReport, StatsReport, BottleneckReport } from "./core/telemetry_aggregator";

// ─── ANSI Palette ────────────────────────────────────────────────────────────
// Curated for "Starship" feel — not generic terminal colors.

const R = "\x1b[0m";       // Reset
const B = "\x1b[1m";       // Bold
const D = "\x1b[2m";       // Dim
const I = "\x1b[3m";       // Italic
const U = "\x1b[4m";       // Underline

// High-intensity foreground (90-97)
const HI_RED = "\x1b[91m";
const HI_GREEN = "\x1b[92m";
const HI_YELLOW = "\x1b[93m";
const HI_BLUE = "\x1b[94m";
const HI_MAGENTA = "\x1b[95m";
const HI_CYAN = "\x1b[96m";
const HI_WHITE = "\x1b[97m";

// Standard foreground
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const WHITE = "\x1b[37m";

// Backgrounds
const BG_BLUE = "\x1b[44m";
const BG_GREEN = "\x1b[42m";
const BG_RED = "\x1b[41m";
const BG_MAGENTA = "\x1b[45m";

// ─── Symbols ─────────────────────────────────────────────────────────────────

const SYM_PASS = `${HI_GREEN}[OK] ${R}`;
const SYM_FAIL = `${HI_RED}✗${R}`;
const SYM_CONTENT = `${HI_CYAN} (Content)${R}`;
const SYM_LOGIC = `${HI_MAGENTA} (Logic)${R}`;
const SYM_EXEC = `${HI_YELLOW} (Miss)${R}`;
const SYM_ARROW = `${D}→${R}`;
const SYM_DOT = `${D}●${R}`;
const SYM_BAR_FULL = "█";
const SYM_BAR_LIGHT = "░";

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
    if (ms < 0.001) return "0μs";
    if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBar(ratio: number, width: number = 20): string {
    const filled = Math.round(ratio * width);
    const empty = width - filled;
    return `${HI_GREEN}${SYM_BAR_FULL.repeat(filled)}${D}${SYM_BAR_LIGHT.repeat(empty)}${R}`;
}

function padRight(str: string, len: number): string {
    // Account for ANSI codes in string length
    const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
    const pad = Math.max(0, len - visibleLen);
    return str + " ".repeat(pad);
}

function line(ch: string = "─", width: number = 56): string {
    return `${D}${ch.repeat(width)}${R}`;
}

// ─── Terminal Reporter ────────────────────────────────────────────────────────────

export class TerminalReporter {
    private startNs: number;

    constructor() {
        this.startNs = Bun.nanoseconds();
    }

    /**
     * Render the Isolation HUD — top banner with tax recovery and system metabolism.
     */
    renderHUD(taskCount: number, pipelineName: string): void {
        console.log();
        console.log(`  ${BG_BLUE}${B}${HI_WHITE}  ▲ b4mal MISSION CONTROL v1.0  ${R}`);
        console.log(`  ${B}${HI_WHITE}${pipelineName}${R} ${D}(${taskCount} tasks)${R}`);
        console.log(`  ${line()}`);
    }

    /**
     * Render the isolation metrics bar — tax recovered, efficiency, jitter.
     */
    renderIsolationBar(tax: TaxReport): void {
        const effPct = (tax.efficiencyRatio * 100).toFixed(1);
        const bar = fmtBar(tax.efficiencyRatio);

        console.log();
        console.log(`  ${HI_CYAN}${B}ISOLATION METRICS${R}`);
        console.log(`  ${CYAN}› TAX RECOVERED:${R}      ${HI_GREEN}${B}${fmtMs(tax.totalMsSaved)}${R} ${D}across ${tax.logicalHits} logical hit${tax.logicalHits !== 1 ? "s" : ""}${R}`);
        console.log(`  ${CYAN}› EFFICIENCY:${R}         ${bar} ${HI_WHITE}${effPct}%${R}`);
        console.log(`  ${CYAN}› I/O JITTER:${R}         ${tax.totalJitterMs > 10 ? HI_YELLOW : D}${fmtMs(tax.totalJitterMs)}${R}`);
    }

    /**
     * Render wave start header.
     */
    renderWaveStart(depth: number, count: number): void {
        console.log(`\n  ${D}wave ${depth}${R} ${D}(${count} parallel)${R}`);
    }

    /**
     * Render task start — print the bullet before execution.
     */
    renderTaskStart(id: string): void {
        process.stdout.write(`  ${SYM_DOT} ${padRight(id, 28)} ${SYM_ARROW} `);
    }

    /**
     * Render task end — status icon + timing + cache type.
     */
    renderTaskEnd(result: TaskResult): void {
        const icon = result.cacheHit === "logic"
            ? SYM_LOGIC
            : result.cacheHit === "content"
                ? SYM_CONTENT
                : result.exitCode === 0 ? SYM_PASS : SYM_FAIL;

        let label: string;
        if (result.cacheHit === "content") {
            label = `${D}cached${R}`;
        } else if (result.cacheHit === "logic") {
            label = `${HI_MAGENTA}logical hit${R}`;
        } else {
            label = fmtMs(result.durationMs);
        }

        console.log(`${icon} ${label}`);
    }

    /**
     * Render the metabolic profile for a task (if metadata available).
     */
    renderMetabolicProfile(result: TaskResult, metadata?: Record<string, unknown>): void {
        if (!metadata) return;

        const telem = metadata.telemetry as { max_rss_kb?: number; io_wait_ms?: number } | undefined;
        if (!telem) return;

        const mem = telem.max_rss_kb ? `${(telem.max_rss_kb / 1024).toFixed(1)}MB` : "—";
        const io = telem.io_wait_ms ? fmtMs(telem.io_wait_ms) : "0μs";

        console.log(`  ${D}  └ mem: ${mem} │ io: ${io}${R}`);
    }

    /**
     * Render the bottleneck warning if a single task dominates.
     */
    renderBottleneck(bottleneck: BottleneckReport): void {
        if (bottleneck.durationMs <= 0) return;

        console.log();
        console.log(`  ${HI_RED}${B}[WARN] BOTTLENECK${R}`);
        console.log(`  ${RED}› ${bottleneck.id}${R} ${D}(${fmtMs(bottleneck.durationMs)}, ${bottleneck.hitType})${R}`);
        if (bottleneck.ioWaitMs > 0) {
            console.log(`  ${D}  └ I/O wait: ${fmtMs(bottleneck.ioWaitMs)}${R}`);
        }
    }

    /**
     * Render the Flight Summary — final status bar.
     */
    renderFlightSummary(result: PipelineResult): void {
        console.log(`\n  ${line()}`);

        const passed = result.tasks.filter((t) => t.exitCode === 0).length;
        const failed = result.tasks.filter((t) => t.exitCode !== 0).length;
        const contentHits = result.tasks.filter((t) => t.cacheHit === "content").length;
        const logicHits = result.tasks.filter((t) => t.cacheHit === "logic").length;
        const executions = result.tasks.filter((t) => !t.cacheHit).length;

        const statusBadge = result.success
            ? `${BG_GREEN}${B}${HI_WHITE} PASS ${R}`
            : `${BG_RED}${B}${HI_WHITE} FAIL ${R}`;

        const wallTime = fmtMs(result.totalDurationMs);
        const elapsedMs = (Bun.nanoseconds() - this.startNs) / 1e6;

        console.log(`  ${statusBadge} ${B}${wallTime}${R} ${D}(${fmtMs(elapsedMs)} total)${R}`);

        // Flight summary tokens
        const tokens: string[] = [];
        if (passed > 0) tokens.push(`${HI_GREEN}${passed} passed${R}`);
        if (failed > 0) tokens.push(`${HI_RED}${failed} failed${R}`);
        if (contentHits > 0) tokens.push(`${HI_CYAN}${contentHits} (Content)${R}`);
        if (logicHits > 0) tokens.push(`${HI_MAGENTA}${logicHits} (Logic)${R}`);
        if (executions > 0) tokens.push(`${HI_YELLOW}${executions} (Miss)${R}`);
        tokens.push(`${YELLOW}overhead: ${fmtMs(result.overheadMs)}${R}`);

        console.log(`  ${tokens.join("  ")}`);
        console.log();
    }
}

// ─── Legacy API (backward compatibility) ─────────────────────────────────────
// These functions are preserved so existing engine code works during migration.

export function reportPipelineStart(name: string, taskCount: number): void {
    const reporter = new TerminalReporter();
    reporter.renderHUD(taskCount, name);
}

export function reportTaskStart(id: string): void {
    process.stdout.write(`  ${SYM_DOT} ${padRight(id, 28)} ${SYM_ARROW} `);
}

export function reportTaskEnd(result: TaskResult): void {
    const icon = result.cacheHit === "logic"
        ? SYM_LOGIC
        : result.cacheHit === "content"
            ? SYM_CONTENT
            : result.exitCode === 0 ? SYM_PASS : SYM_FAIL;

    let label: string;
    if (result.cacheHit === "content") {
        label = `${D}cached${R}`;
    } else if (result.cacheHit === "logic") {
        label = `${HI_MAGENTA}logical hit${R}`;
    } else {
        label = fmtMs(result.durationMs);
    }

    console.log(`${icon} ${label}`);
}

export function reportWaveStart(depth: number, count: number): void {
    console.log(`\n  ${D}wave ${depth} (${count} parallel)${R}`);
}

export function reportPipelineEnd(result: PipelineResult): void {
    console.log(`\n  ${line()}`);

    const passed = result.tasks.filter((t) => t.exitCode === 0).length;
    const failed = result.tasks.filter((t) => t.exitCode !== 0).length;
    const contentHits = result.tasks.filter((t) => t.cacheHit === "content").length;
    const logicHits = result.tasks.filter((t) => t.cacheHit === "logic").length;
    const executions = result.tasks.filter((t) => !t.cacheHit).length;

    const statusBadge = result.success
        ? `${BG_GREEN}${B}${HI_WHITE} PASS ${R}`
        : `${BG_RED}${B}${HI_WHITE} FAIL ${R}`;

    console.log(`  ${statusBadge} ${fmtMs(result.totalDurationMs)}`);

    const tokens: string[] = [];
    if (passed > 0) tokens.push(`${HI_GREEN}${passed} passed${R}`);
    if (failed > 0) tokens.push(`${HI_RED}${failed} failed${R}`);
    if (contentHits > 0) tokens.push(`${HI_CYAN}${contentHits} (Content)${R}`);
    if (logicHits > 0) tokens.push(`${HI_MAGENTA}${logicHits} (Logic)${R}`);
    if (executions > 0) tokens.push(`${HI_YELLOW}${executions} (Miss)${R}`);
    tokens.push(`${YELLOW}overhead: ${fmtMs(result.overheadMs)}${R}`);

    console.log(`  ${tokens.join("  ")}`);
    console.log();
}

export function reportDryRun(dagOutput: string): void {
    console.log(dagOutput);
}

export function reportError(message: string): void {
    console.error(`\n  ${HI_RED}${B}error:${R} ${message}\n`);
}

export function reportValidationErrors(errors: string[]): void {
    console.error(`\n  ${HI_RED}${B}validation errors:${R}`);
    for (const err of errors) {
        console.error(`    ${RED}•${R} ${err}`);
    }
    console.error();
}
