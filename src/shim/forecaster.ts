/**
 * B4mal v2.1.0 — Core Forecast Engine
 *
 * Structural volatility analysis using Bun's Transpiler.
 * Computes the Logic Delta (ΔL) by comparing raw source size
 * to transpiled (type/comment-stripped) output size.
 *
 * Recovery = Σ(AvgTaskTime × (Density_comments + Ratio_types))
 */

const transpiler = new Bun.Transpiler({ loader: "ts" });

export interface FileVolatility {
    path: string;
    rawSize: number;
    logicSize: number;
    volatility: number; // 0.0 = pure logic, 1.0 = all comments/types
}

export interface ForecastResult {
    taskCount: number;
    filesScanned: number;
    logicVolatileFiles: number;
    volatilityFactor: number;
    estimatedTaxRecovery: number; // milliseconds per run
    estimatedMonthlyHours: number; // hours at 100 runs/month
    message: string;
}

/**
 * Calculate the logic volatility of a single TypeScript source string.
 * Volatility = 1 - (transpiled_size / raw_size)
 * High volatility = lots of comments, types, interfaces stripped by transpiler.
 */
export function measureVolatility(source: string): number {
    if (source.trim().length === 0) return 0;

    try {
        const transpiled = transpiler.transformSync(source);
        const rawSize = source.length;
        const logicSize = transpiled.trim().length;

        if (rawSize === 0) return 0;
        return Math.max(0, 1 - logicSize / rawSize);
    } catch {
        return 0; // Non-TS content: assume no volatility
    }
}

/**
 * Scan an array of file contents and calculate aggregate volatility.
 */
export function scanVolatility(files: Array<{ path: string; content: string }>): {
    fileResults: FileVolatility[];
    aggregateVolatility: number;
    volatileCount: number;
} {
    const VOLATILE_THRESHOLD = 0.3; // >30% stripped = "logic-volatile"
    const fileResults: FileVolatility[] = [];
    let volatileCount = 0;

    for (const file of files) {
        const volatility = measureVolatility(file.content);
        const rawSize = file.content.length;
        const logicSize = Math.round(rawSize * (1 - volatility));

        fileResults.push({ path: file.path, rawSize, logicSize, volatility });
        if (volatility >= VOLATILE_THRESHOLD) volatileCount++;
    }

    const totalVolatility = fileResults.reduce((sum, f) => sum + f.volatility, 0);
    const aggregateVolatility = fileResults.length > 0
        ? totalVolatility / fileResults.length
        : 0;

    return { fileResults, aggregateVolatility, volatileCount };
}

/**
 * Generate a Core Forecast for a migrated pipeline.
 *
 * @param taskCount Number of tasks in the migrated pipeline
 * @param files Source files to scan for volatility (optional — uses synthetic estimate if not provided)
 * @param avgTaskMs Average task execution time in milliseconds (default: 450ms)
 */
export function generateForecast(
    taskCount: number,
    files?: Array<{ path: string; content: string }>,
    avgTaskMs: number = 450
): ForecastResult {
    let volatilityFactor: number;
    let filesScanned: number;
    let logicVolatileFiles: number;

    if (files && files.length > 0) {
        const scan = scanVolatility(files);
        volatilityFactor = scan.aggregateVolatility;
        filesScanned = files.length;
        logicVolatileFiles = scan.volatileCount;
    } else {
        // Conservative structural estimate when no files available
        volatilityFactor = 0.25; // 25% baseline for typical TS projects
        filesScanned = 0;
        logicVolatileFiles = 0;
    }

    const estimatedTaxRecovery = taskCount * avgTaskMs * volatilityFactor;
    const runsPerMonth = 100;
    const estimatedMonthlyHours = (estimatedTaxRecovery * runsPerMonth) / 3_600_000;

    const message = [
        `Migration complete. Based on your ${taskCount}-task DAG,`,
        filesScanned > 0
            ? `b4mal scanned ${filesScanned} source files and found ${logicVolatileFiles} logic-volatile candidates (${(volatilityFactor * 100).toFixed(1)}% structural volatility).`
            : `b4mal estimates ${(volatilityFactor * 100).toFixed(1)}% structural volatility based on project baseline.`,
        `Projected recovery: ${estimatedTaxRecovery.toFixed(0)}ms per run (${estimatedMonthlyHours.toFixed(2)} hours/month at ${runsPerMonth} runs).`,
    ].join(" ");

    return {
        taskCount,
        filesScanned,
        logicVolatileFiles,
        volatilityFactor,
        estimatedTaxRecovery,
        estimatedMonthlyHours,
        message,
    };
}
