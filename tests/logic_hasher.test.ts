/**
 * Tests: Logic Hasher (v0.5.0)
 *
 * RED PHASE — Written before implementation.
 * Tests the AST-aware normalization pipeline.
 */
import { describe, test, expect } from "bun:test";
import { generateLogicHash } from "../src/core/logic_hasher";

describe("generateLogicHash", () => {
    // ─── Comment Invariance ──────────────────────────────────────────────────

    test("comment invariance: trailing comment is stripped", async () => {
        const a = await generateLogicHash(`const x = 1;`);
        const b = await generateLogicHash(`const x = 1; // This is a comment`);
        expect(a).toBe(b);
    });

    test("comment invariance: block comment is stripped", async () => {
        const a = await generateLogicHash(`const x = 1;`);
        const b = await generateLogicHash(`/* block comment */ const x = 1;`);
        expect(a).toBe(b);
    });

    test("comment invariance: multiline block comment is stripped", async () => {
        const a = await generateLogicHash(`function foo() { return 42; }`);
        const b = await generateLogicHash(`
      /**
       * This is a JSDoc comment
       * @param none
       */
      function foo() { return 42; }
    `);
        expect(a).toBe(b);
    });

    test("comment invariance: comment-only file vs empty", async () => {
        const a = await generateLogicHash(``);
        const b = await generateLogicHash(`// just a comment\n/* another */`);
        expect(a).toBe(b);
    });

    // ─── Whitespace Invariance ───────────────────────────────────────────────

    test("whitespace invariance: multi-line vs single-line", async () => {
        const multiLine = `
      function add(a, b) {
        return a + b;
      }
    `;
        const singleLine = `function add(a, b) { return a + b; }`;
        const a = await generateLogicHash(multiLine);
        const b = await generateLogicHash(singleLine);
        expect(a).toBe(b);
    });

    test("whitespace invariance: extra blank lines are ignored", async () => {
        const a = await generateLogicHash(`const x = 1;\nconst y = 2;`);
        const b = await generateLogicHash(`const x = 1;\n\n\n\nconst y = 2;`);
        expect(a).toBe(b);
    });

    test("whitespace invariance: tabs vs spaces", async () => {
        const a = await generateLogicHash(`function f() {\n  return 1;\n}`);
        const b = await generateLogicHash(`function f() {\n\treturn 1;\n}`);
        expect(a).toBe(b);
    });

    // ─── Type Annotation Invariance ──────────────────────────────────────────

    test("type invariance: function with type annotations", async () => {
        const typed = `function add(a: number, b: number): number { return a + b; }`;
        const untyped = `function add(a, b) { return a + b; }`;
        const a = await generateLogicHash(typed);
        const b = await generateLogicHash(untyped);
        expect(a).toBe(b);
    });

    test("type invariance: interface-only file normalizes to empty", async () => {
        const a = await generateLogicHash(``);
        const b = await generateLogicHash(`
      interface Foo {
        bar: string;
        baz: number;
      }
    `);
        expect(a).toBe(b);
    });

    test("type invariance: const with type annotation", async () => {
        const a = await generateLogicHash(`const x = 42;`);
        const b = await generateLogicHash(`const x: number = 42;`);
        expect(a).toBe(b);
    });

    test("type invariance: generic function", async () => {
        const a = await generateLogicHash(`function id(x) { return x; }`);
        const b = await generateLogicHash(`function id<T>(x: T): T { return x; }`);
        expect(a).toBe(b);
    });

    // ─── Semantic Sensitivity ────────────────────────────────────────────────

    test("different logic produces different hash", async () => {
        const a = await generateLogicHash(`const x = 1;`);
        const b = await generateLogicHash(`const x = 2;`);
        expect(a).not.toBe(b);
    });

    test("different function names produce different hash", async () => {
        const a = await generateLogicHash(`function foo() { return 1; }`);
        const b = await generateLogicHash(`function bar() { return 1; }`);
        expect(a).not.toBe(b);
    });

    test("additional statement changes hash", async () => {
        const a = await generateLogicHash(`const x = 1;`);
        const b = await generateLogicHash(`const x = 1; const y = 2;`);
        expect(a).not.toBe(b);
    });

    // ─── Determinism ─────────────────────────────────────────────────────────

    test("hash is deterministic across calls", async () => {
        const code = `export function greet(name: string): string { return "hello " + name; }`;
        const a = await generateLogicHash(code);
        const b = await generateLogicHash(code);
        expect(a).toBe(b);
    });

    test("hash is a hex string", async () => {
        const hash = await generateLogicHash(`const x = 1;`);
        expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    // ─── Non-TS Fallback ────────────────────────────────────────────────────

    test("non-TS content falls back gracefully", async () => {
        const hash = await generateLogicHash(`{"key": "value"}`);
        expect(hash).toBeTruthy();
        expect(typeof hash).toBe("string");
    });

    // ─── Performance ─────────────────────────────────────────────────────────

    test("performance: <5ms for 500-line file", async () => {
        // Generate a 500-line TS file
        const lines: string[] = [];
        for (let i = 0; i < 500; i++) {
            lines.push(`export function func_${i}(x: number): number { return x + ${i}; }`);
        }
        const bigFile = lines.join("\n");

        const start = Bun.nanoseconds();
        await generateLogicHash(bigFile);
        const elapsedMs = (Bun.nanoseconds() - start) / 1e6;

        expect(elapsedMs).toBeLessThan(5);
    });
});
