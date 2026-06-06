// Tests: Optimization Report
//
// Validates the Markdown report engine: Amdahl's Law efficiency,
// critical path formatting, refactor proposals, zero-idle edge case,
// and the "Build Simulations" overlay.

import { describe, test, expect } from "bun:test";
import {
    OptimizationReport,
    type OptimizationData,
    type PathTask,
    type RefactorProposal,
} from "../src/reporter/optimization_report";

// ─── Math Verification ──────────────────────────────────────────────────────

describe("OptimizationReport - Amdahl's Law", () => {
    test("60s critical path / 100s build = exactly 60.00% efficiency", () => {
        const data: OptimizationData = {
            criticalPath: [
                { id: "compile", durationMs: 40000 },
                { id: "test", durationMs: 20000 },
            ],
            wavePlan: [
                { depth: 0, taskIds: ["compile", "lint"] },
                { depth: 1, taskIds: ["test"] },
            ],
            theoreticalMinMs: 60000,
            actualCurrentMs: 100000,
            proposals: [],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);

        expect(report).toContain("60.00%");
        expect(report).toContain("100,000ms");
        expect(report).toContain("60,000ms");
    });

    test("savings potential is calculated correctly", () => {
        const data: OptimizationData = {
            criticalPath: [{ id: "build", durationMs: 30000 }],
            wavePlan: [{ depth: 0, taskIds: ["build", "lint"] }],
            theoreticalMinMs: 30000,
            actualCurrentMs: 80000,
            proposals: [],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);

        // 80000 - 30000 = 50000ms savings potential
        expect(report).toContain("50,000ms");
    });
});

// ─── Path Formatting ─────────────────────────────────────────────────────────

describe("OptimizationReport - Critical Path", () => {
    test("critical path is listed in chronological dependency order", () => {
        const data: OptimizationData = {
            criticalPath: [
                { id: "fetch-deps", durationMs: 5000 },
                { id: "compile", durationMs: 30000 },
                { id: "link", durationMs: 8000 },
                { id: "test", durationMs: 17000 },
            ],
            wavePlan: [],
            theoreticalMinMs: 60000,
            actualCurrentMs: 90000,
            proposals: [],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);

        // Must appear in order: fetch-deps → compile → link → test
        const fetchIdx = report.indexOf("fetch-deps");
        const compileIdx = report.indexOf("compile");
        const linkIdx = report.indexOf("link");
        const testIdx = report.indexOf("test");

        expect(fetchIdx).toBeLessThan(compileIdx);
        expect(compileIdx).toBeLessThan(linkIdx);
        expect(linkIdx).toBeLessThan(testIdx);
    });

    test("each task shows its duration in the path", () => {
        const data: OptimizationData = {
            criticalPath: [{ id: "compile", durationMs: 42000 }],
            wavePlan: [],
            theoreticalMinMs: 42000,
            actualCurrentMs: 42000,
            proposals: [],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);
        expect(report).toContain("42,000ms");
    });
});

// ─── Proposal Integrity ──────────────────────────────────────────────────────

describe("OptimizationReport - Refactor Proposals", () => {
    test("MCP suggest_optimizations proposals are embedded in the report", () => {
        const data: OptimizationData = {
            criticalPath: [{ id: "build", durationMs: 10000 }],
            wavePlan: [{ depth: 0, taskIds: ["build", "test"] }],
            theoreticalMinMs: 10000,
            actualCurrentMs: 20000,
            proposals: [
                {
                    taskA: "build",
                    taskB: "test",
                    sharedClaim: "fs:dist/",
                    reason: 'Tasks "build" and "test" both claim "fs:dist/"',
                    suggestion: 'Split "fs:dist/" into task-specific paths',
                },
            ],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);

        expect(report).toContain("build");
        expect(report).toContain("test");
        expect(report).toContain("fs:dist/");
        expect(report).toContain("Split");
    });
});

// ─── Zero-Idle Case ──────────────────────────────────────────────────────────

describe("OptimizationReport - Edge Cases", () => {
    test("perfectly optimized build (T_serial = T_total) shows 100% efficiency", () => {
        const data: OptimizationData = {
            criticalPath: [{ id: "build", durationMs: 50000 }],
            wavePlan: [{ depth: 0, taskIds: ["build"] }],
            theoreticalMinMs: 50000,
            actualCurrentMs: 50000,
            proposals: [],
            shadowSimulations: [],
        };

        const report = OptimizationReport.generate(data);

        expect(report).toContain("100.00%");
        // No savings potential
        expect(report).toContain("0ms");
    });
});

// ─── Build Simulation ─────────────────────────────────────────────────────────

describe("OptimizationReport - Build Simulation", () => {
    test("build simulation results are included", () => {
        const data: OptimizationData = {
            criticalPath: [
                { id: "compile", durationMs: 40000 },
                { id: "test", durationMs: 20000 },
            ],
            wavePlan: [
                { depth: 0, taskIds: ["compile"] },
                { depth: 1, taskIds: ["test", "lint"] },
            ],
            theoreticalMinMs: 60000,
            actualCurrentMs: 100000,
            proposals: [],
            shadowSimulations: [
                {
                    description: 'Isolating "fs:logs/" from test',
                    projectedSavingsMs: 14000,
                    gainPercent: 23,
                },
            ],
        };

        const report = OptimizationReport.generate(data);

        expect(report).toContain("Build Simulations");
        expect(report).toContain("fs:logs/");
        expect(report).toContain("14,000ms");
        expect(report).toContain("23%");
    });
});
