/**
 * @file audit.ts
 * @description Declares the foundational interfaces and types for the cryptographic auditing subsystem.
 */

import { Database } from "bun:sqlite";

// ─── ANSI Palette ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const HI_GREEN = "\x1b[92m";
const HI_YELLOW = "\x1b[93m";
const HI_CYAN = "\x1b[96m";
const HI_WHITE = "\x1b[97m";
const HI_RED = "\x1b[91m";
const HI_MAGENTA = "\x1b[95m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BG_GREEN = "\x1b[42m";
const BG_RED = "\x1b[41m";

// ─── Report Types ────────────────────────────────────────────────────────────

export interface AuditReport {
    totalTasks: number;
    logicalHits: number;
    contentHits: number;
    misses: number;
    logicalEfficiency: number;
    cumulativeTaxMs: number;
    avgDurationMs: number;
    estimatedHoursSaved: number;
    isolationStatus: "HIGH" | "LOW";
    windowDays: number;
}

// ─── Audit Engine ────────────────────────────────────────────────────────────

export class CoreAudit {
    constructor(private db: Database) { }

    /**
     * Generate a 30-day (default) historical report.
     * Uses SQLite json_extract for zero-overhead metadata parsing.
     */
    generateReport(windowDays: number = 30): AuditReport {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - windowDays);
        const cutoffISO = cutoff.toISOString();

        const row = this.db
            .query(
                `SELECT
                    COUNT(*) as total_tasks,
                    COALESCE(SUM(CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isolation.hit_type') = 'LOGICAL_HIT' THEN 1 ELSE 0 END), 0) as logical_hits,
                    COALESCE(SUM(CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isolation.hit_type') = 'CONTENT_HIT' THEN 1 ELSE 0 END), 0) as content_hits,
                    COALESCE(SUM(CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isolation.hit_type') = 'MISS' THEN 1 ELSE 0 END), 0) as misses,
                    COALESCE(SUM(CASE WHEN json_valid(metadata) AND json_extract(metadata, '$.isolation.hit_type') = 'LOGICAL_HIT' THEN json_extract(metadata, '$.isolation.tax_recovered_ms') ELSE 0 END), 0) as tax_ms,
                    COALESCE(AVG(duration_ms), 0) as avg_duration
                 FROM task_cache_v2
                 WHERE created_at >= ?`
            )
            .get(cutoffISO) as {
                total_tasks: number;
                logical_hits: number;
                content_hits: number;
                misses: number;
                tax_ms: number;
                avg_duration: number;
            };

        const totalTasks = row.total_tasks;
        const logicalEfficiency = totalTasks > 0 ? (row.logical_hits / totalTasks) * 100 : 0;
        const estimatedHoursSaved = row.tax_ms / 3_600_000;
        const isolationStatus: "HIGH" | "LOW" = logicalEfficiency >= 20 ? "HIGH" : "LOW";

        return {
            totalTasks,
            logicalHits: row.logical_hits,
            contentHits: row.content_hits,
            misses: row.misses,
            logicalEfficiency,
            cumulativeTaxMs: row.tax_ms,
            avgDurationMs: row.avg_duration,
            estimatedHoursSaved,
            isolationStatus,
            windowDays,
        };
    }

    /**
     * Render the Core Audit to terminal.
     */
    printReport(report: AuditReport): void {
        const effPct = report.logicalEfficiency.toFixed(1);
        const fmtMs = (ms: number) => ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
        const bar = this.renderBar(report.logicalEfficiency / 100, 24);

        console.log();
        console.log(`  ${BG_GREEN}${B}${HI_WHITE}  ▲ b4mal CORE AUDIT (${report.windowDays}D)  ${R}`);
        console.log(`  ${"─".repeat(50)}`);
        console.log(`  ${CYAN}› Total Tasks Processed:${R}  ${B}${HI_WHITE}${report.totalTasks}${R}`);
        console.log(`  ${CYAN}› Logical Cache Efficacy:${R} ${bar} ${B}${HI_GREEN}${effPct}%${R}`);
        console.log(`  ${CYAN}› Cache Miss Overhead Saved:${R}  ${B}${HI_YELLOW}${fmtMs(report.cumulativeTaxMs)}${R}`);
        console.log(`  ${CYAN}› Avg Task Duration:${R}     ${D}${fmtMs(report.avgDurationMs)}${R}`);
        console.log(`  ${CYAN}› Estimated Productivity:${R} ${B}${HI_MAGENTA}${report.estimatedHoursSaved.toFixed(2)} Human-Hours${R}`);
        console.log(`  ${"─".repeat(50)}`);

        // Hit breakdown
        console.log(`  ${D}breakdown:${R} ${HI_CYAN}${report.contentHits} (Content)${R} ${HI_MAGENTA}${report.logicalHits} (Logic)${R} ${HI_YELLOW}${report.misses} (Miss)${R}`);

        // Isolation status
        if (report.isolationStatus === "HIGH") {
            console.log(`\n  ${HI_GREEN}${B}[OK] HIGH ISOLATION${R} ${D}Your team is at high velocity.${R}`);
        } else {
            console.log(`\n  ${HI_RED}${B}[WARN] LOW EFFICACY${R} ${D}Consider increasing module granularity.${R}`);
        }
        console.log();
    }

    private renderBar(ratio: number, width: number): string {
        const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
        const empty = width - filled;
        return `${HI_GREEN}${"█".repeat(filled)}${D}${"░".repeat(empty)}${R}`;
    }
}
