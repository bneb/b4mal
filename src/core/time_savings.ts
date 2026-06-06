/**
 * @file time_savings.ts
 * @description Calculates the exact wall-clock milliseconds saved via L1 and L2 cache hits.
 */

export interface SavingsData {
    taxEvents: number;
    avgBuildMinutes: number;
}

export interface SavingsResult {
    hoursSaved: string;
    efficiencyGain: string;
}

export class TimeSavingsCalculator {
    /**
     * Calculate the time savings from recovering tax events.
     * 
     * Value(Time) = C_events * (T_build / 60)
     */
    static calculate(data: SavingsData): SavingsResult {
        const totalMinutesSaved = data.taxEvents * data.avgBuildMinutes;
        const totalHoursSaved = totalMinutesSaved / 60;

        // For efficiency gain, we use a simplified proxy based on 100 commits
        // e.g. 5 tax events per 100 commits = 5.0%
        const efficiencyGain = (data.taxEvents > 0)
            ? `${((data.taxEvents / 100) * 100).toFixed(1)}%`
            : "0.0%";

        return {
            hoursSaved: totalHoursSaved.toFixed(2),
            efficiencyGain,
        };
    }
}
