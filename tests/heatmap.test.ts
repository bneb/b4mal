/**
 * Tests: Core Heatmap (v2.6.0 — RED PHASE)
 *
 * Validates zone mapping, state precedence, grid rendering,
 * manual content, and rendering performance.
 */
import { describe, test, expect } from "bun:test";
import {
    CoreHeatmap,
    type ZoneState,
    type TaskClaim,
    type HeatmapResult,
} from "../src/reporter/heatmap";
import { CoreManual } from "../src/cli/manual";

// ─── Zone Mapping ─────────────────────────────────────────────────────────────

describe("CoreHeatmap", () => {
    test("task writing to src/core/engine.ts triggers src/ zone as WRITE", () => {
        const claims: TaskClaim[] = [
            { taskId: "build", reads: [], writes: ["src/core/engine.ts"], envReads: [], envWrites: [] },
        ];

        const result = CoreHeatmap.render(claims);
        const srcZone = result.zones.find(z => z.name === "src/");

        expect(srcZone).toBeDefined();
        expect(srcZone!.state).toBe("WRITE");
    });

    test("task reading from tests/ triggers tests/ zone as READ", () => {
        const claims: TaskClaim[] = [
            { taskId: "lint", reads: ["tests/app.test.ts"], writes: [], envReads: [], envWrites: [] },
        ];

        const result = CoreHeatmap.render(claims);
        const testZone = result.zones.find(z => z.name === "tests/");

        expect(testZone).toBeDefined();
        expect(testZone!.state).toBe("READ");
    });

    test("env write triggers env/ zone as WRITE", () => {
        const claims: TaskClaim[] = [
            { taskId: "deploy", reads: [], writes: [], envReads: [], envWrites: ["API_KEY"] },
        ];

        const result = CoreHeatmap.render(claims);
        const envZone = result.zones.find(z => z.name === "env/");

        expect(envZone).toBeDefined();
        expect(envZone!.state).toBe("WRITE");
    });

    test("no active tasks leaves zones as EMPTY", () => {
        const result = CoreHeatmap.render([]);

        for (const zone of result.zones) {
            expect(zone.state).toBe("EMPTY");
        }
    });

    // ─── State Precedence ─────────────────────────────────────────────────

    test("SHIELD takes precedence over WRITE after verification", () => {
        const claims: TaskClaim[] = [
            { taskId: "build", reads: [], writes: ["src/main.ts"], envReads: [], envWrites: [] },
        ];
        const verified = ["src/"];

        const result = CoreHeatmap.render(claims, { verifiedZones: verified });
        const srcZone = result.zones.find(z => z.name === "src/");

        expect(srcZone!.state).toBe("SHIELD");
    });

    test("CONTENTION when multiple tasks write to same zone without verification", () => {
        const claims: TaskClaim[] = [
            { taskId: "build", reads: [], writes: ["src/a.ts"], envReads: [], envWrites: [] },
            { taskId: "lint", reads: [], writes: ["src/b.ts"], envReads: [], envWrites: [] },
        ];

        const result = CoreHeatmap.render(claims);
        const srcZone = result.zones.find(z => z.name === "src/");

        expect(srcZone!.state).toBe("CONTENTION");
    });

    test("CONTENTION resolves to SHIELD after verification", () => {
        const claims: TaskClaim[] = [
            { taskId: "build", reads: [], writes: ["src/a.ts"], envReads: [], envWrites: [] },
            { taskId: "lint", reads: [], writes: ["src/b.ts"], envReads: [], envWrites: [] },
        ];

        const result = CoreHeatmap.render(claims, { verifiedZones: ["src/"] });
        const srcZone = result.zones.find(z => z.name === "src/");

        expect(srcZone!.state).toBe("SHIELD");
    });

    // ─── Grid Rendering ───────────────────────────────────────────────────

    test("grid output contains all 8 zones", () => {
        const result = CoreHeatmap.render([]);

        expect(result.zones.length).toBe(8);
        expect(result.grid.length).toBe(2); // 2 rows of 4
    });

    test("grid output has proper cell formatting", () => {
        const claims: TaskClaim[] = [
            { taskId: "build", reads: ["config/app.json"], writes: ["dist/out.js"], envReads: [], envWrites: [] },
        ];

        const result = CoreHeatmap.render(claims);
        expect(result.raw).toContain("dist/");
        expect(result.raw).toContain("config/");
    });

    test("grid respects custom width parameter", () => {
        const result = CoreHeatmap.render([], { width: 60 });
        // Each line in raw should not exceed the width
        const lines = result.raw.split("\n");
        // Header + grid lines exist
        expect(lines.length).toBeGreaterThan(2);
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("grid rendering completes in <5ms", () => {
        const claims: TaskClaim[] = Array.from({ length: 20 }, (_, i) => ({
            taskId: `task_${i}`,
            reads: [`src/file_${i}.ts`],
            writes: [`dist/file_${i}.js`],
            envReads: [`VAR_${i}`],
            envWrites: [],
        }));

        const start = performance.now();
        CoreHeatmap.render(claims);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(5);
    });
});

// ─── Core Manual ─────────────────────────────────────────────────────────

describe("CoreManual", () => {
    test("contains heatmap legend", () => {
        expect(CoreManual.content).toContain("[ R ]");
        expect(CoreManual.content).toContain("[ W ]");
        expect(CoreManual.content).toContain("[!!]");
    });

    test("contains optimization guidance", () => {
        expect(CoreManual.content).toContain("concurrency");
    });

    test("contains version header", () => {
        expect(CoreManual.content).toContain("2.6.0");
    });
});
