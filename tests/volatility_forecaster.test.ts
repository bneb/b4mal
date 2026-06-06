import { describe, test, expect } from "bun:test";
import { join } from "path";
import { promises as fs } from "fs";
import { VolatilityForecaster } from "../src/core/volatility_forecaster";

describe("Volatility Forecaster", () => {
    test("forecasts default values for unknown tasks", () => {
        const forecaster = new VolatilityForecaster();
        const forecast = forecaster.forecast("unknown");
        expect(forecast.expectedDurationMs).toBe(1000);
        expect(forecast.cacheMissProbability).toBe(0.5);
    });

    test("computes accurate expected duration and cache miss probability", () => {
        const forecaster = new VolatilityForecaster();
        forecaster.record("task-1", 100, false);
        forecaster.record("task-1", 200, true);
        forecaster.record("task-1", 300, false);

        const forecast = forecaster.forecast("task-1");
        expect(forecast.expectedDurationMs).toBe(200);
        expect(forecast.cacheMissProbability).toBe(2 / 3);
    });

    test("computes correct volatility score based on standard deviation", () => {
        const forecaster = new VolatilityForecaster();
        // High volatility: standard deviation is large relative to mean
        forecaster.record("task-1", 10, false);
        forecaster.record("task-1", 1000, false);
        const highForecast = forecaster.forecast("task-1");

        // Low volatility: standard deviation is zero
        forecaster.record("task-2", 100, false);
        forecaster.record("task-2", 100, false);
        const lowForecast = forecaster.forecast("task-2");

        expect(highForecast.volatilityScore).toBeGreaterThan(lowForecast.volatilityScore);
        expect(lowForecast.volatilityScore).toBe(0);
    });

    test("persists history across instances", async () => {
        const testPath = join(__dirname, ".test_b4mal", "volatility.json");
        const forecaster1 = new VolatilityForecaster(testPath);
        forecaster1.record("task-persist", 1234, false);
        await forecaster1.save();

        const forecaster2 = new VolatilityForecaster(testPath);
        await forecaster2.load();
        const forecast = forecaster2.forecast("task-persist");

        expect(forecast.expectedDurationMs).toBe(1234);

        // Cleanup
        await fs.rm(join(__dirname, ".test_b4mal"), { recursive: true, force: true });
    });
});
