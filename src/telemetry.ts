/**
 * B4mal v0.1.0 — Telemetry
 *
 * Nanosecond-precision internal timing harness.
 * Foundation for v1.0.0 JPL telemetry stream.
 */

export interface TimingMark {
    label: string;
    startNs: number;
    endNs?: number;
}

export interface PipelineTelemetry {
    engineStartNs: number;
    dagResolutionMs: number;
    taskTimings: Map<string, { durationMs: number; cached: boolean }>;
    totalWallMs: number;
    overheadMs: number;
}

export class Telemetry {
    private marks: Map<string, TimingMark> = new Map();
    private engineStartNs: number;

    constructor() {
        this.engineStartNs = Bun.nanoseconds();
    }

    mark(label: string): void {
        this.marks.set(label, { label, startNs: Bun.nanoseconds() });
    }

    end(label: string): number {
        const mark = this.marks.get(label);
        if (!mark) throw new Error(`No mark found: "${label}"`);
        mark.endNs = Bun.nanoseconds();
        return (mark.endNs - mark.startNs) / 1e6; // ms
    }

    elapsed(label: string): number {
        const mark = this.marks.get(label);
        if (!mark) return 0;
        const end = mark.endNs ?? Bun.nanoseconds();
        return (end - mark.startNs) / 1e6;
    }

    get engineStartupMs(): number {
        return (Bun.nanoseconds() - this.engineStartNs) / 1e6;
    }

    summarize(
        taskTimings: Map<string, { durationMs: number; cached: boolean }>
    ): PipelineTelemetry {
        const totalWallMs = this.elapsed("pipeline");
        const sumTaskMs = Array.from(taskTimings.values()).reduce(
            (acc, t) => acc + (t.cached ? 0 : t.durationMs),
            0
        );
        // Overhead = wall time - max concurrent task time per wave
        // For v0.1.0, we approximate: overhead = wall - sum_of_wave_max
        // Simplified: total wall - longest single task chain
        const overheadMs = Math.max(0, totalWallMs - sumTaskMs);

        return {
            engineStartNs: this.engineStartNs,
            dagResolutionMs: this.elapsed("dag"),
            taskTimings,
            totalWallMs,
            overheadMs,
        };
    }
}
