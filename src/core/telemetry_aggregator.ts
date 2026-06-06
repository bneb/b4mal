/**
 * @file telemetry_aggregator.ts
 * @description Collects timing and execution trace data for the OpenTelemetry exporter.
 */

import { Database } from "bun:sqlite";

export interface TaxReport {
    /** Total milliseconds saved via logical cache hits */
    totalMsSaved: number;
    /** Number of logical (AST-aware) cache hits */
    logicalHits: number;
    /** Efficiency: saved / total_duration of logical hits */
    efficiencyRatio: number;
    /** Total I/O wait jitter across all jobs */
    totalJitterMs: number;
}

export interface BottleneckReport {
    id: string;
    durationMs: number;
    hitType: string;
    ioWaitMs: number;
}

export interface StatsReport {
    totalJobs: number;
    contentHits: number;
    logicalHits: number;
    misses: number;
    totalDurationMs: number;
}

export class TelemetryAggregator {
    /**
     * Calculate the Cache Miss Overhead recovered.
     * Tax Recovered = Sum(tax_recovered_ms) for LOGICAL_HIT entries.
     * Efficiency = totalSaved / totalDuration of logical hits.
     */
    static calculateTaxSaved(db: Database): TaxReport {
        // Sum tax recovered from logical hits
        const taxRow = db
            .query(
                `SELECT
                    COALESCE(SUM(json_extract(metadata, '$.isolation.tax_recovered_ms')), 0) as saved_ms,
                    COALESCE(SUM(duration_ms), 0) as total_duration,
                    COUNT(*) as hit_count
                 FROM task_cache_v2
                 WHERE json_extract(metadata, '$.isolation.hit_type') = 'LOGICAL_HIT'`
            )
            .get() as { saved_ms: number; total_duration: number; hit_count: number };

        // Total I/O jitter across ALL jobs
        const jitterRow = db
            .query(
                `SELECT COALESCE(SUM(json_extract(metadata, '$.telemetry.io_wait_ms')), 0) as total_jitter
                 FROM task_cache_v2`
            )
            .get() as { total_jitter: number };

        const totalMsSaved = taxRow.saved_ms;
        const totalDuration = taxRow.total_duration;
        const efficiencyRatio = totalDuration > 0 ? totalMsSaved / totalDuration : 0;

        return {
            totalMsSaved,
            logicalHits: taxRow.hit_count,
            efficiencyRatio,
            totalJitterMs: jitterRow.total_jitter,
        };
    }

    /**
     * Find the slowest task — the critical path bottleneck.
     */
    static findBottleneck(db: Database): BottleneckReport {
        const row = db
            .query(
                `SELECT
                    id,
                    duration_ms,
                    json_extract(metadata, '$.isolation.hit_type') as hit_type,
                    COALESCE(json_extract(metadata, '$.telemetry.io_wait_ms'), 0) as io_wait_ms
                 FROM task_cache_v2
                 ORDER BY duration_ms DESC
                 LIMIT 1`
            )
            .get() as { id: string; duration_ms: number; hit_type: string; io_wait_ms: number } | null;

        if (!row) {
            return { id: "(none)", durationMs: 0, hitType: "MISS", ioWaitMs: 0 };
        }

        return {
            id: row.id,
            durationMs: row.duration_ms,
            hitType: row.hit_type,
            ioWaitMs: row.io_wait_ms,
        };
    }

    /**
     * Get aggregate stats across all cached jobs.
     */
    static getStats(db: Database): StatsReport {
        const row = db
            .query(
                `SELECT
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN json_extract(metadata, '$.isolation.hit_type') = 'CONTENT_HIT' THEN 1 ELSE 0 END), 0) as content_hits,
                    COALESCE(SUM(CASE WHEN json_extract(metadata, '$.isolation.hit_type') = 'LOGICAL_HIT' THEN 1 ELSE 0 END), 0) as logical_hits,
                    COALESCE(SUM(CASE WHEN json_extract(metadata, '$.isolation.hit_type') = 'MISS' THEN 1 ELSE 0 END), 0) as misses,
                    COALESCE(SUM(duration_ms), 0) as total_duration
                 FROM task_cache_v2`
            )
            .get() as {
                total: number;
                content_hits: number;
                logical_hits: number;
                misses: number;
                total_duration: number;
            };

        return {
            totalJobs: row.total,
            contentHits: row.content_hits,
            logicalHits: row.logical_hits,
            misses: row.misses,
            totalDurationMs: row.total_duration,
        };
    }
}
