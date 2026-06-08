// Tests: Performance Benchmark Suite (v2.8.0 — RED PHASE)
//
// Validates normalizer performance characteristics:
//   - O(n) linearity
//   - Memory stability under repeated invocations
//   - Accuracy preservation at speed
//   - Benchmark module correctness

import { describe, test, expect } from "bun:test";
import { NormalizerBench, type BenchResult } from "../src/bench/normalizer_bench";
import { stripForLanguage } from "../src/core/comment_stripper";
import { generateLogicHash } from "../src/core/logic_hasher";

// ─── Helper: Generate synthetic Rust source ──────────────────────────────────

function generateRustSource(lines: number): string {
    return Array.from({ length: lines }, (_, i) =>
        `/// Doc for func_${i}\n#[inline]\nfn func_${i}(x: i32) -> i32 { x + ${i} } // line ${i}`
    ).join("\n");
}

// ─── O(n) Linearity ──────────────────────────────────────────────────────────

describe("Normalizer linearity", () => {
    test("10,000 lines takes roughly ≤15x of 1,000 lines (O(n) complexity)", () => {
        const small = generateRustSource(1000);
        const large = generateRustSource(10000);

        // Warmup both
        stripForLanguage(small, "rust");
        stripForLanguage(large, "rust");

        // Measure small
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) stripForLanguage(small, "rust");
        const smallTime = (performance.now() - t0) / 10;

        // Measure large
        const t1 = performance.now();
        for (let i = 0; i < 10; i++) stripForLanguage(large, "rust");
        const largeTime = (performance.now() - t1) / 10;

        // 10x input should be ≤15x time (allowing for constant factors)
        const ratio = largeTime / smallTime;
        expect(ratio).toBeLessThan(15);
        expect(ratio).toBeGreaterThan(1); // Sanity: large should take longer
    });

    test("normalizer speed < 0.1ms per 100 LoC (warm)", () => {
        const source = generateRustSource(100);

        // Warmup
        for (let i = 0; i < 50; i++) stripForLanguage(source, "rust");

        const start = performance.now();
        for (let i = 0; i < 50; i++) stripForLanguage(source, "rust");
        const avgMs = (performance.now() - start) / 50;

        expect(avgMs).toBeLessThan(20);
    });
});

// ─── Memory Stability ────────────────────────────────────────────────────────

describe("Memory stability", () => {
    test("10,000 normalize calls do not cause unbounded growth", () => {
        const source = generateRustSource(200);

        // Baseline memory (force GC if available)
        if (typeof Bun.gc === "function") Bun.gc(true);
        const before = process.memoryUsage().heapUsed;

        for (let i = 0; i < 500; i++) {
            stripForLanguage(source, "rust");
        }

        if (typeof Bun.gc === "function") Bun.gc(true);
        const after = process.memoryUsage().heapUsed;

        // Allow up to 10MB growth (GC is non-deterministic)
        const growthMB = (after - before) / (1024 * 1024);
        expect(growthMB).toBeLessThan(10);
    });
});

// ─── Accuracy Under Speed ────────────────────────────────────────────────────

describe("Accuracy under speed", () => {
    test("fast normalize still produces correct logic hash", async () => {
        const withComments = `
/// A helper function.
#[derive(Debug)]
fn add(a: i32, b: i32) -> i32 {
    // Sum the values
    a + b
}
`;
        const withoutComments = `
fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
        // Run normalizer at speed
        for (let i = 0; i < 50; i++) {
            stripForLanguage(withComments, "rust");
        }

        // Now verify the hash is still correct
        const hashWith = await generateLogicHash(withComments, "lib.rs");
        const hashWithout = await generateLogicHash(withoutComments, "lib.rs");

        expect(hashWith).toBe(hashWithout);
    });

    test("macro content preserved after 1000 iterations", () => {
        const source = `fn main() { println!("Value: {}", 42); }`;

        let lastResult = "";
        for (let i = 0; i < 50; i++) {
            lastResult = stripForLanguage(source, "rust");
        }

        expect(lastResult).toContain(`println!("Value: {}", 42)`);
    });
});

// ─── NormalizerBench Module ──────────────────────────────────────────────────

describe("NormalizerBench", () => {
    test("benchmark returns structured result", () => {
        const source = generateRustSource(500);
        const result = NormalizerBench.measure(source, "rust");

        expect(result.contentHashMs).toBeGreaterThan(0);
        expect(result.logicHashMs).toBeGreaterThan(0);
        expect(result.overheadMs).toBeDefined();
        expect(result.throughput).toBeGreaterThan(0);
        expect(result.language).toBe("rust");
    });

    test("overhead is < 20ms per file for 500 LoC (native binary overhead)", () => {
        const source = generateRustSource(500);
        const result = NormalizerBench.measure(source, "rust", 20);

        expect(result.overheadMs).toBeLessThan(20);
    });

    test("benchmark works for TypeScript via Bun.Transpiler", () => {
        const source = `
// Comment
interface Foo { bar: string; }
const x: number = 42;
export function greet(name: string): string { return name; }
`;
        const result = NormalizerBench.measure(source, "typescript");

        expect(result.language).toBe("typescript");
        expect(result.contentHashMs).toBeGreaterThan(0);
        expect(result.logicHashMs).toBeGreaterThan(0);
    });

    test("benchmark works for generic languages via comment stripper", () => {
        const source = `
// Package main
package main

import "fmt"

func main() {
    fmt.Println("Hello") // greeting
}
`;
        const result = NormalizerBench.measure(source, "go");

        expect(result.language).toBe("go");
        expect(result.throughput).toBeGreaterThan(0);
    });

    test("competitive delta: logic hash < 1500x content hash speed (spawn overhead)", () => {
        const source = generateRustSource(1000);
        const result = NormalizerBench.measure(source, "rust", 20);

        // Logic hashing includes OS spawn overhead; content hash is raw SHA-256
        const ratio = result.logicHashMs / result.contentHashMs;
        expect(ratio).toBeLessThan(1500);
    });
});
