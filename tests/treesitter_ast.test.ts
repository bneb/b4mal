// Tests: Tree-sitter AST Integration (v4.0.0 — RED-to-GREEN)
//
// Validates that the ImportTracer now uses real Tree-sitter AST parsing
// instead of regex, correctly handling aliased imports, re-exports,
// dynamic imports, and Rust mod/use statements.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ImportTracer, type DependencyGraph } from "../src/discovery/graph";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

let testRoot: string;

beforeAll(async () => {
    testRoot = path.join(os.tmpdir(), "b4mal-treesitter-test-" + Date.now());

    // TS files with various import patterns
    await fs.mkdir(path.join(testRoot, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "src", "utils"), { recursive: true });
    await fs.mkdir(path.join(testRoot, "src", "api"), { recursive: true });

    // Aliased import (import * as X)
    await fs.writeFile(path.join(testRoot, "src", "api", "routes.ts"),
        `import * as auth from "../auth/login";\nexport function routes() {}`);

    // Re-export (export { X } from)
    await fs.writeFile(path.join(testRoot, "src", "auth", "index.ts"),
        `export { login } from "./login";\nexport { session } from "./session";`);

    // Standard + require
    await fs.writeFile(path.join(testRoot, "src", "auth", "login.ts"),
        `import { getConnection } from "../utils/db";\nconst legacy = require("../utils/compat");\nexport function login() {}`);

    // Dynamic import
    await fs.writeFile(path.join(testRoot, "src", "auth", "session.ts"),
        `const lazy = import("../utils/heavy");\nexport function session() {}`);

    // Target files
    await fs.writeFile(path.join(testRoot, "src", "utils", "db.ts"),
        `export function getConnection() {}`);
    await fs.writeFile(path.join(testRoot, "src", "utils", "compat.ts"),
        `module.exports = { compat: true };`);
    await fs.writeFile(path.join(testRoot, "src", "utils", "heavy.ts"),
        `export function heavy() {}`);
});

afterAll(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

// ─── Tree-sitter AST Parsing ─────────────────────────────────────────────────

describe("ImportTracer - Tree-sitter AST", () => {
    test("parserEngine reports 'tree-sitter', not 'regex'", () => {
        const tracer = new ImportTracer();
        expect(tracer.getParserEngine()).toBe("tree-sitter");
    });

    test("aliased imports (import * as X) are traced", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        const aliased = graph.edges.find(e =>
            e.source.includes("routes.ts") && e.target.includes("login.ts")
        );
        expect(aliased).toBeDefined();
    });

    test("re-exports (export { X } from) create edges", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        const reexport = graph.edges.find(e =>
            e.source.includes("index.ts") && e.target.includes("login.ts")
        );
        expect(reexport).toBeDefined();

        const reexport2 = graph.edges.find(e =>
            e.source.includes("index.ts") && e.target.includes("session.ts")
        );
        expect(reexport2).toBeDefined();
    });

    test("require() calls are traced", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        const requireEdge = graph.edges.find(e =>
            e.source.includes("login.ts") && e.target.includes("compat.ts")
        );
        expect(requireEdge).toBeDefined();
    });

    test("dynamic import() is classified as dynamic", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        const dynamicEdge = graph.edges.find(e =>
            e.source.includes("session.ts") && e.target.includes("heavy.ts")
        );
        expect(dynamicEdge).toBeDefined();
        expect(dynamicEdge!.type).toBe("dynamic");
    });

    test("standard static imports are classified as static", async () => {
        const tracer = new ImportTracer();
        const graph = await tracer.trace(testRoot);

        const staticEdge = graph.edges.find(e =>
            e.source.includes("login.ts") && e.target.includes("db.ts")
        );
        expect(staticEdge).toBeDefined();
        expect(staticEdge!.type).toBe("static");
    });
});
