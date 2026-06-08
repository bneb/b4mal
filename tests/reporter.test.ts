import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
    TerminalReporter,
    reportPipelineStart,
    reportTaskStart,
    reportTaskEnd,
    reportWaveStart,
    reportPipelineEnd,
    reportDryRun,
    reportError,
    reportValidationErrors
} from "../src/reporter";
import type { TaskResult, PipelineResult } from "../src/schema";
import type { TaxReport, BottleneckReport } from "../src/core/telemetry_aggregator";

describe("reporter.ts", () => {
    let logSpy: any;
    let writeSpy: any;
    let errorSpy: any;

    beforeEach(() => {
        logSpy = spyOn(console, "log").mockImplementation(() => {});
        writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
        errorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        writeSpy.mockRestore();
        errorSpy.mockRestore();
    });

    // ─── TerminalReporter ────────────────────────────────────────────────────────
    describe("TerminalReporter", () => {
        test("renderHUD", () => {
            const reporter = new TerminalReporter();
            reporter.renderHUD(5, "TestPipeline");
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderIsolationBar", () => {
            const reporter = new TerminalReporter();
            const tax: TaxReport = {
                totalMsSaved: 1200,
                logicalHits: 2,
                totalJitterMs: 15,
                efficiencyRatio: 0.85
            };
            reporter.renderIsolationBar(tax);
            expect(logSpy).toHaveBeenCalled();
            // test singular logical hit and low jitter
            reporter.renderIsolationBar({
                totalMsSaved: 1,
                logicalHits: 1,
                totalJitterMs: 1,
                efficiencyRatio: 0.1
            });
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderWaveStart", () => {
            const reporter = new TerminalReporter();
            reporter.renderWaveStart(1, 3);
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderTaskStart", () => {
            const reporter = new TerminalReporter();
            reporter.renderTaskStart("task-id");
            expect(writeSpy).toHaveBeenCalled();
        });

        test("renderTaskEnd", () => {
            const reporter = new TerminalReporter();
            reporter.renderTaskEnd({ id: "1", durationMs: 50, exitCode: 0, stdout: "", stderr: "", cacheHit: false });
            reporter.renderTaskEnd({ id: "2", durationMs: 0.0005, exitCode: 0, stdout: "", stderr: "", cacheHit: false }); // < 0.001
            reporter.renderTaskEnd({ id: "3", durationMs: 0.5, exitCode: 0, stdout: "", stderr: "", cacheHit: false }); // < 1
            reporter.renderTaskEnd({ id: "4", durationMs: 1500, exitCode: 1, stdout: "", stderr: "", cacheHit: false }); // >= 1000, error
            reporter.renderTaskEnd({ id: "5", durationMs: 50, exitCode: 0, cacheHit: "content", stdout: "", stderr: "" });
            reporter.renderTaskEnd({ id: "6", durationMs: 50, exitCode: 0, cacheHit: "logic", stdout: "", stderr: "" });
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderMetabolicProfile", () => {
            const reporter = new TerminalReporter();
            const res: TaskResult = { id: "1", durationMs: 50, exitCode: 0, stdout: "", stderr: "", cacheHit: false };
            reporter.renderMetabolicProfile(res, undefined); // should skip
            reporter.renderMetabolicProfile(res, {}); // should skip
            reporter.renderMetabolicProfile(res, { telemetry: {} }); // should skip
            reporter.renderMetabolicProfile(res, { telemetry: { max_rss_kb: 1024, io_wait_ms: 5 } });
            reporter.renderMetabolicProfile(res, { telemetry: { io_wait_ms: 0.5 } }); // no max rss
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderBottleneck", () => {
            const reporter = new TerminalReporter();
            reporter.renderBottleneck({ id: "1", durationMs: 0, ioWaitMs: 0, hitType: "execution" }); // should skip
            reporter.renderBottleneck({ id: "2", durationMs: 150, ioWaitMs: 0, hitType: "execution" });
            reporter.renderBottleneck({ id: "3", durationMs: 250, ioWaitMs: 50, hitType: "execution" });
            expect(logSpy).toHaveBeenCalled();
        });

        test("renderFlightSummary", () => {
            const reporter = new TerminalReporter();
            const pipelineRes: PipelineResult = {
                name: "test",
                success: true,
                tasks: [
                    { id: "1", durationMs: 10, exitCode: 0, stdout: "", stderr: "", cacheHit: false },
                    { id: "2", durationMs: 10, exitCode: 0, cacheHit: "content", stdout: "", stderr: "" },
                    { id: "3", durationMs: 10, exitCode: 0, cacheHit: "logic", stdout: "", stderr: "" }
                ],
                totalDurationMs: 30,
                overheadMs: 5
            };
            reporter.renderFlightSummary(pipelineRes);
            const failRes: PipelineResult = {
                name: "test",
                success: false,
                tasks: [
                    { id: "1", durationMs: 10, exitCode: 1, stdout: "", stderr: "", cacheHit: false }
                ],
                totalDurationMs: 10,
                overheadMs: 5
            };
            reporter.renderFlightSummary(failRes);
            expect(logSpy).toHaveBeenCalled();
        });
    });

    // ─── Legacy API ─────────────────────────────────────────────────────────
    describe("Legacy API", () => {
        test("reportPipelineStart", () => {
            reportPipelineStart("Test", 5);
            expect(logSpy).toHaveBeenCalled();
        });

        test("reportTaskStart", () => {
            reportTaskStart("task-1");
            expect(writeSpy).toHaveBeenCalled();
        });

        test("reportTaskEnd", () => {
            reportTaskEnd({ id: "1", durationMs: 50, exitCode: 0, stdout: "", stderr: "", cacheHit: false });
            reportTaskEnd({ id: "2", durationMs: 0.0005, exitCode: 0, stdout: "", stderr: "", cacheHit: false });
            reportTaskEnd({ id: "3", durationMs: 0.5, exitCode: 0, stdout: "", stderr: "", cacheHit: false });
            reportTaskEnd({ id: "4", durationMs: 1500, exitCode: 1, stdout: "", stderr: "", cacheHit: false });
            reportTaskEnd({ id: "5", durationMs: 50, exitCode: 0, cacheHit: "content", stdout: "", stderr: "" });
            reportTaskEnd({ id: "6", durationMs: 50, exitCode: 0, cacheHit: "logic", stdout: "", stderr: "" });
            expect(logSpy).toHaveBeenCalled();
        });

        test("reportWaveStart", () => {
            reportWaveStart(1, 3);
            expect(logSpy).toHaveBeenCalled();
        });

        test("reportPipelineEnd", () => {
            reportPipelineEnd({
                name: "test",
                success: true,
                tasks: [
                    { id: "1", durationMs: 10, exitCode: 0, stdout: "", stderr: "", cacheHit: false },
                    { id: "2", durationMs: 10, exitCode: 0, cacheHit: "content", stdout: "", stderr: "" },
                    { id: "3", durationMs: 10, exitCode: 0, cacheHit: "logic", stdout: "", stderr: "" }
                ],
                totalDurationMs: 30,
                overheadMs: 5
            });
            reportPipelineEnd({
                name: "test",
                success: false,
                tasks: [
                    { id: "1", durationMs: 10, exitCode: 1, stdout: "", stderr: "", cacheHit: false }
                ],
                totalDurationMs: 10,
                overheadMs: 5
            });
            expect(logSpy).toHaveBeenCalled();
        });

        test("reportDryRun", () => {
            reportDryRun("DAG output");
            expect(logSpy).toHaveBeenCalled();
        });

        test("reportError", () => {
            reportError("Some error");
            expect(errorSpy).toHaveBeenCalled();
        });

        test("reportValidationErrors", () => {
            reportValidationErrors(["error 1", "error 2"]);
            expect(errorSpy).toHaveBeenCalled();
        });
    });
});
