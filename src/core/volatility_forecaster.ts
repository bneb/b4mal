/**
 * @file volatility_forecaster.ts
 * @description Predicts the likelihood of cache misses based on historical file modification rates.
 */

import { join, dirname } from "path";
import { promises as fs } from "fs";

export interface TaskHistory {
    durations: number[];
    cacheMisses: number;
    totalRuns: number;
}

export interface VolatilityForecast {
    expectedDurationMs: number;
    cacheMissProbability: number;
    volatilityScore: number; // 0 to 1, higher means more volatile
}

export class VolatilityForecaster {
    private history = new Map<string, TaskHistory>();
    private dbPath: string;

    constructor(dbPath?: string) {
        this.dbPath = dbPath || join(process.cwd(), ".b4mal", "volatility.json");
    }

    async load(): Promise<void> {
        try {
            const data = await fs.readFile(this.dbPath, "utf-8");
            const parsed = JSON.parse(data);
            for (const [key, val] of Object.entries(parsed)) {
                this.history.set(key, val as TaskHistory);
            }
        } catch (e: any) {
            if (e.code !== "ENOENT") {
                console.warn("Failed to load volatility forecaster history:", e.message);
            }
        }
    }

    async save(): Promise<void> {
        try {
            await fs.mkdir(dirname(this.dbPath), { recursive: true });
            const obj = Object.fromEntries(this.history);
            await fs.writeFile(this.dbPath, JSON.stringify(obj, null, 2), "utf-8");
        } catch (e: any) {
            console.warn("Failed to save volatility forecaster history:", e.message);
        }
    }

    record(taskId: string, durationMs: number, cacheHit: boolean) {
        let stats = this.history.get(taskId);
        if (!stats) {
            stats = { durations: [], cacheMisses: 0, totalRuns: 0 };
            this.history.set(taskId, stats);
        }
        if (stats.durations.length >= 100) {
            stats.durations.shift();
        }
        stats.durations.push(durationMs);
        stats.totalRuns++;
        if (!cacheHit) {
            stats.cacheMisses++;
        }
    }

    forecast(taskId: string): VolatilityForecast {
        const stats = this.history.get(taskId);
        if (!stats || stats.durations.length === 0) {
            return { expectedDurationMs: 1000, cacheMissProbability: 0.5, volatilityScore: 0.5 };
        }

        const expectedDurationMs = stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length;
        const cacheMissProbability = stats.cacheMisses / stats.totalRuns;
        
        // Variance
        const variance = stats.durations.reduce((acc, val) => acc + Math.pow(val - expectedDurationMs, 2), 0) / stats.durations.length;
        const stdDev = Math.sqrt(variance);
        
        // Normalize volatility (coefficient of variation bounded to 1)
        let volatilityScore = expectedDurationMs > 0 ? stdDev / expectedDurationMs : 0;
        volatilityScore = Math.min(Math.max(volatilityScore, 0), 1);

        return { expectedDurationMs, cacheMissProbability, volatilityScore };
    }
}
