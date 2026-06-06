import { test, expect } from "bun:test";
import { TuiReporter } from "../src/reporter/tui_hud";
import type { TaskResult } from "../src/schema";

test("TuiReporter - handles task states and generates lines without throwing", () => {
    const reporter = new TuiReporter(["A", "B", "C"], "TestPipeline");
    
    // Start A
    reporter.renderTaskStart("A");
    let output = reporter.generateFrame();
    expect(output).toContain("A");
    expect(output).toContain("running");

    // End A, Start B
    reporter.renderTaskEnd({
        id: "A",
        exitCode: 0,
        durationMs: 150,
        stdout: "",
        stderr: "",
        cacheHit: "content"
    });
    reporter.renderTaskStart("B");
    
    output = reporter.generateFrame();
    expect(output).toContain("cached"); // A is cached
    expect(output).toContain("B");
    expect(output).toContain("running");

    // Stop reporter (clears interval if started)
    reporter.stop();
});
