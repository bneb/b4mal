/**
 * Tests: Core Forecast Engine (v2.1.0 — RED PHASE)
 *
 * Validates structural volatility measurement using Bun's Transpiler.
 * Tests comment density, type-to-logic ratio, and scan performance.
 */
import { describe, test, expect } from "bun:test";
import { measureVolatility, scanVolatility, generateForecast } from "../src/shim/forecaster";

describe("CoreForecast", () => {
    // ─── Volatility Measurement ───────────────────────────────────────────

    test("90% comment file yields high volatility", () => {
        const source = `
// This is a comment
// Another comment
// Yet another comment
// More comments here
// And even more
// Comments everywhere
// So many comments
// Almost all comments
// One more comment line
const x = 1; // actual logic
`;
        const v = measureVolatility(source);
        // Most of the source is comments → high volatility
        expect(v).toBeGreaterThan(0.4);
    });

    test("minified JS (no comments/types) yields near-zero volatility", () => {
        const source = `const a=1;const b=2;const c=a+b;function foo(x){return x*x}const d=foo(c);`;
        const v = measureVolatility(source);
        expect(v).toBeLessThan(0.15);
    });

    test("type-heavy file yields high volatility", () => {
        const source = `
interface User {
    id: string;
    name: string;
    email: string;
    age: number;
    address: {
        street: string;
        city: string;
        state: string;
        zip: string;
    };
}

type UserRole = "admin" | "user" | "moderator";

interface Permission {
    role: UserRole;
    canDelete: boolean;
    canEdit: boolean;
}

export const getUser = (id: string): User => ({ id, name: "", email: "", age: 0, address: { street: "", city: "", state: "", zip: "" } });
`;
        const v = measureVolatility(source);
        // >40% types/interfaces → high volatility
        expect(v).toBeGreaterThan(0.3);
    });

    test("empty source returns 0 volatility", () => {
        expect(measureVolatility("")).toBe(0);
        expect(measureVolatility("   ")).toBe(0);
    });

    // ─── Batch Scanning ───────────────────────────────────────────────────

    test("scanVolatility aggregates across multiple files", () => {
        const files = [
            { path: "a.ts", content: "const x = 1;" },
            { path: "b.ts", content: "// all comments\n// more\nconst y = 1;" },
            { path: "c.ts", content: "interface Foo { bar: string }\nconst z = 1;" },
        ];

        const result = scanVolatility(files);
        expect(result.fileResults).toHaveLength(3);
        expect(result.aggregateVolatility).toBeGreaterThanOrEqual(0);
        expect(result.aggregateVolatility).toBeLessThanOrEqual(1);
    });

    test("volatile threshold correctly classifies files", () => {
        const files = [
            { path: "pure.ts", content: "const a=1;const b=2;const c=a+b;" }, // Low volatility
            {
                path: "heavy.ts",
                content: `
// comment 1
// comment 2
// comment 3
// comment 4
interface X { a: string; b: number; c: boolean; d: string; e: number }
type Y = "a" | "b" | "c";
const z = 1;
`,
            }, // High volatility
        ];

        const result = scanVolatility(files);
        // At least the heavy file should be volatile
        expect(result.volatileCount).toBeGreaterThanOrEqual(1);
    });

    // ─── Forecast Generation ──────────────────────────────────────────────

    test("generateForecast with files produces grounded estimate", () => {
        const files = [
            { path: "a.ts", content: "// lots of comments\n// more\nconst x = 1;" },
            { path: "b.ts", content: "interface Foo { x: string }\nconst y = 1;" },
        ];

        const forecast = generateForecast(5, files);
        expect(forecast.taskCount).toBe(5);
        expect(forecast.filesScanned).toBe(2);
        expect(forecast.estimatedTaxRecovery).toBeGreaterThan(0);
        expect(forecast.message).toContain("b4mal");
        expect(forecast.message).toContain("5-task");
    });

    test("generateForecast without files uses conservative baseline", () => {
        const forecast = generateForecast(10);
        expect(forecast.taskCount).toBe(10);
        expect(forecast.filesScanned).toBe(0);
        expect(forecast.volatilityFactor).toBe(0.25); // 25% baseline
        expect(forecast.estimatedTaxRecovery).toBeGreaterThan(0);
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("scan completes in <200ms for 100 files", () => {
        const files = Array.from({ length: 100 }, (_, i) => ({
            path: `src/file_${i}.ts`,
            content: `
// Module ${i}
interface Config_${i} { key: string; value: number }
type Status_${i} = "active" | "inactive";
export function process_${i}(c: Config_${i}): Status_${i} {
    return c.value > 0 ? "active" : "inactive";
}
`,
        }));

        const start = performance.now();
        const result = scanVolatility(files);
        const elapsed = performance.now() - start;

        expect(result.fileResults).toHaveLength(100);
        expect(elapsed).toBeLessThan(200);
    });
});
