// B4mal v2.8.0 — Normalizer Performance Benchmark
//
// Measures cold start vs warm throughput for:
//   - Content hash (SHA-256 baseline)
//   - Logic hash (language-specific normalization + SHA-256)
//
// Exposes structured BenchResult for programmatic access
// and formatted ANSI output for CLI.

import { stripForLanguage, type LanguageId } from "../core/comment_stripper";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BenchResult {
    language: string;
    contentHashMs: number;   // Avg ms for raw SHA-256
    logicHashMs: number;     // Avg ms for normalize + SHA-256
    overheadMs: number;      // logicHashMs - contentHashMs
    throughput: number;      // files/sec at logicHash speed
    inputBytes: number;
    iterations: number;
}

// ─── Bench Core ──────────────────────────────────────────────────────────────

const WARMUP = 100;
const ITERATIONS = 1000;

const bunTranspiler = new Bun.Transpiler({ loader: "ts" });

export class NormalizerBench {
    /**
     * Measure normalizer performance for a given source string + language.
     * Returns structured metrics comparing content-hash vs logic-hash.
     */
    static measure(source: string, language: string, iterations = ITERATIONS): BenchResult {
        const inputBytes = new TextEncoder().encode(source).length;

        const warmupCount = language === "rust" ? 5 : WARMUP;
        const actualIterations = language === "rust" && iterations === ITERATIONS ? 50 : iterations;

        // ── Warmup ───────────────────────────────────────────────────────
        for (let i = 0; i < warmupCount; i++) {
            this.contentHash(source);
            this.logicNormalize(source, language);
        }

        // ── Content Hash Measurement ─────────────────────────────────────
        const ct0 = performance.now();
        for (let i = 0; i < actualIterations; i++) {
            this.contentHash(source);
        }
        const contentHashMs = (performance.now() - ct0) / actualIterations;

        // ── Logic Hash Measurement ───────────────────────────────────────
        const lt0 = performance.now();
        for (let i = 0; i < actualIterations; i++) {
            const normalized = this.logicNormalize(source, language);
            const hasher = new Bun.CryptoHasher("sha256");
            hasher.update(normalized);
            hasher.digest("hex");
        }
        const logicHashMs = (performance.now() - lt0) / actualIterations;

        const overheadMs = logicHashMs - contentHashMs;
        const throughput = 1000 / logicHashMs;

        return {
            language,
            contentHashMs,
            logicHashMs,
            overheadMs,
            throughput,
            inputBytes,
            iterations: actualIterations,
        };
    }

    /**
     * Format a BenchResult as ANSI terminal output.
     */
    static format(result: BenchResult): string {
        const lines = [
            "",
            "  ▲ PERFORMANCE BENCHMARK: NORMALIZER",
            "  ─────────────────────────────────────────────",
            `  › Language:      ${result.language}`,
            `  › Input:         ${(result.inputBytes / 1024).toFixed(1)} KB`,
            `  › Iterations:    ${result.iterations}`,
            "  ─────────────────────────────────────────────",
            `  › Content Hash:  ${result.contentHashMs.toFixed(4)}ms`,
            `  › Logic Hash:    ${result.logicHashMs.toFixed(4)}ms`,
            `  › Overhead:      ${result.overheadMs.toFixed(4)}ms`,
            `  › Throughput:    ${result.throughput.toFixed(0)} files/sec`,
            "  ─────────────────────────────────────────────",
            "",
        ];
        return lines.join("\n");
    }

    // ─── Internal ────────────────────────────────────────────────────────

    private static contentHash(source: string): string {
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(source);
        return hasher.digest("hex");
    }

    private static logicNormalize(source: string, language: string): string {
        if (language === "rust" || language === "go" || language === "python" || language === "c" || language === "cpp") {
            return stripForLanguage(source, language as LanguageId);
        }

        if (language === "typescript" || language === "javascript") {
            try {
                return bunTranspiler.transformSync(source).trim();
            } catch {
                return stripForLanguage(source, language as LanguageId);
            }
        }

        // All other languages: state-machine tokenizer
        return stripForLanguage(source, language as LanguageId);
    }
}
