// Tests: Optimization Report Generator
//
// Validates TimeSavingsCalculator precision and edge cases.
// Also validates the Markdown template generator output.

import { describe, test, expect } from "bun:test";
import { TimeSavingsCalculator, type SavingsData } from "../src/core/time_savings";
import { ProposalTemplate } from "../src/reporter/proposal_template";

// ─── Precision Verification ──────────────────────────────────────────────────

describe("TimeSavingsCalculator - Precision Verification", () => {
    test("42 tax events at 8 minutes = 5.6 hours", () => {
        const data: SavingsData = {
            taxEvents: 42,
            avgBuildMinutes: 8,
        };

        const result = TimeSavingsCalculator.calculate(data);

        // 42 * 8 = 336 minutes = 5.60 hours
        expect(result.hoursSaved).toBe("5.60");
        expect(result.efficiencyGain).toBe("42.0%");
    });
});

// ─── Zero-Tax Edge Case ──────────────────────────────────────────────────────

describe("TimeSavingsCalculator - Zero Tax Edge Case", () => {
    test("0 tax events returns 0.00 hours", () => {
        const result = TimeSavingsCalculator.calculate({
            taxEvents: 0,
            avgBuildMinutes: 8,
        });

        expect(result.hoursSaved).toBe("0.00");
        expect(result.efficiencyGain).toBe("0.0%");
    });
});

// ─── Template Generation ─────────────────────────────────────────────────────

describe("ProposalTemplate - Markdown Integrity", () => {
    const mockAudit = {
        commitsScanned: 500,
        taxEvents: 42,
        totalSavedSeconds: 20160,
        filesAnalyzed: 12,
        logicChanges: 40,
        taxRate: 8.4,
    };

    const mockSavings = TimeSavingsCalculator.calculate({
        taxEvents: 42,
        avgBuildMinutes: 8,
    });

    test("generates valid GFM headers and tables", () => {
        const report = ProposalTemplate.generate("nMeshed", mockAudit, mockSavings);

        // Check headers
        expect(report).toContain("# Optimization Report: nMeshed");
        expect(report).toContain("## 1. Summary");
        expect(report).toContain("## 2. Cache Miss Overhead");
        expect(report).toContain("## 3. The Logic Engine");
        expect(report).toContain("## 4. Conclusion");

        // Check tables
        expect(report).toContain("| Metric | Value |");
        expect(report).toContain("|:---|:---|");
        expect(report).toContain("| Hours Recovered | **5.60** |");
        expect(report).toContain("| Efficiency Gain | **42.0%** |");
    });

    test("zero-tax edge case explicitly praises peak efficiency", () => {
        const zeroSavings = TimeSavingsCalculator.calculate({
            taxEvents: 0,
            avgBuildMinutes: 8,
        });

        const report = ProposalTemplate.generate("perfectRepo", { ...mockAudit, taxEvents: 0 }, zeroSavings);

        expect(report).toContain("Peak Efficiency");
        // The standard report says "Cache Miss Overhead — computational cycles spent" vs the perfect repo
        expect(report).not.toContain("Cache Miss Overhead — computational cycles spent");
    });
});
