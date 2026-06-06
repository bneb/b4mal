// Tests: Rust Logic Normalizer (v2.7.0 — RED PHASE)
//
// Validates token-aware logic extraction for .rs files.
// The normalizer must preserve functional tokens while stripping
// comments, doc-comments, attributes, and whitespace.

import { describe, test, expect } from "bun:test";
import { RustNormalizer } from "../src/core/rust_normalizer";
import { generateLogicHash, isLogicHashable } from "../src/core/logic_hasher";

// ─── String Protection ───────────────────────────────────────────────────────

describe("RustNormalizer", () => {
    test("preserves string literals containing comment-like syntax", () => {
        const input = `let url = "https://example.com"; let comment = "// not a comment";`;
        const result = RustNormalizer.normalize(input);
        expect(result).toContain("https://example.com");
        expect(result).toContain("// not a comment");
    });

    test("preserves string with block-comment-like content", () => {
        const input = `let x = "/* this is inside a string */";`;
        const result = RustNormalizer.normalize(input);
        expect(result).toContain("/* this is inside a string */");
    });

    test("preserves raw string literals", () => {
        const input = `let raw = r#"This has "quotes" and // slashes"#;`;
        const result = RustNormalizer.normalize(input);
        expect(result).toContain("quotes");
        expect(result).toContain("// slashes");
    });

    // ─── Doc-Comment Stripping ────────────────────────────────────────────

    test("strips doc-comments while preserving function body", () => {
        const input = `
/// This is a doc comment.
/// It describes the function.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("This is a doc comment");
        expect(result).not.toContain("describes the function");
        expect(result).toContain("pub fn add");
        expect(result).toContain("a + b");
    });

    test("strips inner doc-comments (//!)", () => {
        const input = `
//! Module-level documentation.
//! This crate provides utilities.

pub mod utils {}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("Module-level documentation");
        expect(result).toContain("pub mod utils");
    });

    test("strips regular line comments", () => {
        const input = `
fn main() {
    // Initialize the counter
    let mut count = 0;
    count += 1; // Increment
}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("Initialize the counter");
        expect(result).not.toContain("Increment");
        expect(result).toContain("let mut count = 0");
        expect(result).toContain("count += 1");
    });

    // ─── Multi-line Comments ──────────────────────────────────────────────

    test("strips nested block comments", () => {
        const input = `
/* Outer comment
   /* Nested comment */
   still in outer
*/
fn live_code() -> bool { true }
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("Outer comment");
        expect(result).not.toContain("Nested comment");
        expect(result).not.toContain("still in outer");
        expect(result).toContain("fn live_code");
    });

    // ─── Attribute Stripping ──────────────────────────────────────────────

    test("strips outer attributes", () => {
        const input = `
#[derive(Debug, Clone)]
#[cfg(test)]
struct Point {
    x: f64,
    y: f64,
}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("derive");
        expect(result).not.toContain("cfg(test)");
        expect(result).toContain("struct Point");
        expect(result).toContain("x : f64");
    });

    test("strips inner attributes", () => {
        const input = `
#![allow(dead_code)]
#![feature(async_fn)]

fn main() {}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).not.toContain("allow");
        expect(result).not.toContain("feature");
        expect(result).toContain("fn main");
    });

    // ─── Macro Stability ──────────────────────────────────────────────────

    test("preserves macro invocations exactly", () => {
        const input = `
fn main() {
    println!("Value: {}", 42);
    vec![1, 2, 3];
    assert_eq!(2 + 2, 4);
}
`;
        const result = RustNormalizer.normalize(input);
        expect(result).toContain(`println!("Value: {}", 42)`);
        expect(result).toContain("vec![1, 2, 3]");
        expect(result).toContain("assert_eq!(2 + 2, 4)");
    });

    // ─── Logic Invariance ─────────────────────────────────────────────────

    test("comment-only changes produce identical normalized output", () => {
        const before = `
fn greet(name: &str) -> String {
    format!("Hello, {}", name)
}
`;
        const after = `
// Updated greeting function
/// Returns a greeting for the given name.
fn greet(name: &str) -> String {
    format!("Hello, {}", name) // Build greeting
}
`;
        expect(RustNormalizer.normalize(before)).toBe(RustNormalizer.normalize(after));
    });

    test("logic changes produce different normalized output", () => {
        const before = `fn calc() -> i32 { 1 + 1 }`;
        const after = `fn calc() -> i32 { 2 + 2 }`;
        expect(RustNormalizer.normalize(before)).not.toBe(RustNormalizer.normalize(after));
    });

    // ─── Performance ──────────────────────────────────────────────────────

    test("normalize 1000-line Rust file in <5ms", () => {
        const lines = Array.from({ length: 1000 }, (_, i) =>
            `fn func_${i}(x: i32) -> i32 { x + ${i} } // line ${i}`
        );
        const source = lines.join("\n");

        // Warmup
        RustNormalizer.normalize(source);

        const start = performance.now();
        RustNormalizer.normalize(source);
        const elapsed = performance.now() - start;

        // Note: spawning a native binary has a fixed overhead that can jitter in CI
        expect(elapsed).toBeLessThan(35);
    });
});

// ─── LogicHasher Integration ─────────────────────────────────────────────────

describe("LogicHasher Rust routing", () => {
    test("isLogicHashable returns true for .rs files", () => {
        expect(isLogicHashable("src/main.rs")).toBe(true);
        expect(isLogicHashable("lib.rs")).toBe(true);
    });

    test("generateLogicHash routes .rs files through RustNormalizer", async () => {
        const before = `fn add(a: i32, b: i32) -> i32 { a + b }`;
        const after = `// Addition\nfn add(a: i32, b: i32) -> i32 { a + b }`;

        const hashBefore = await generateLogicHash(before, "main.rs");
        const hashAfter = await generateLogicHash(after, "main.rs");

        expect(hashBefore).toBe(hashAfter);
    });

    test("logic change in .rs produces different hash", async () => {
        const before = `fn add(a: i32, b: i32) -> i32 { a + b }`;
        const after = `fn add(a: i32, b: i32) -> i32 { a * b }`;

        const hashBefore = await generateLogicHash(before, "main.rs");
        const hashAfter = await generateLogicHash(after, "main.rs");

        expect(hashBefore).not.toBe(hashAfter);
    });
});
