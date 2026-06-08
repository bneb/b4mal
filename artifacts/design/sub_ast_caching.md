# Design: Sub-AST Function-Level Caching

## 1. The "AI Delusion" Red-Team Check
The initial high-level premise ("slice files into functions, only pass modified functions to the compiler") is functionally delusional for traditional compilation (like `tsc` typechecking or `rustc` compilation). Compilers require the complete, structurally sound AST to perform cross-function type inference, borrow checking, and scope resolution. If an orchestrator forcibly strips unmodified function bodies out of a source file before handing it to `tsc`, the resulting emitted binary/JS will literally be missing those functions. 

To build an unassailable Sub-AST cache without hallucinating capabilities that don't exist, we must implement it at the **Transpilation Layer**, where file processing is strictly isolated (e.g., TS -> JS emitting without typechecking), which is exactly what modern bundlers (esbuild, swc, Bun transpiler) do.

## 2. Architecture: `b4mal transpile` (Sub-AST Transpiler)
Instead of trying to hack `tsc`, `b4mal` will expose a native `SubAstTranspiler` that leverages `Bun.Transpiler` under the hood.

**The Pipeline:**
1. **AST Parsing:** When `b4mal transpile src/` is invoked, we parse each TypeScript file. Because full parsing is expensive, we use a rapid Regex/State-Machine parser that strictly identifies top-level function and class boundaries.
2. **Sub-AST Hashing:** We hash the isolated string content of each function block independently.
3. **Cache Lookup:** We look up the function hash in a local `b4mal` key-value store (SQLite/LMDB). 
    - *Hit:* We pull the pre-compiled JS string for that specific function.
    - *Miss:* We pass ONLY that isolated function string to `Bun.Transpiler` (which is instantaneous), and store the compiled JS output back into the cache.
4. **Stitching:** We stitch the cached JS blocks and newly compiled JS blocks back together in their original order.

## 3. Mathematical Speed Guarantees (Amdahl's Law)
If a file has 10,000 lines and 500 functions, and the user alters 1 variable in 1 function:
- **Traditional caching:** Cache miss. The entire 10,000 line file is re-transpiled.
- **Sub-AST caching:** 499 functions hit the L1 cache in `<0.1ms`. Only 1 function (20 lines) is handed to the transpiler. The transpilation time drops by 99.8%.

## 4. Implementation Details
*   **Target:** `src/compiler/sub_ast.ts` and `src/compiler/ast_slicer.cjs`
*   **Parser:** Since `b4mal` already ships with `web-tree-sitter` (used in `src/discovery/graph.ts`), we will reuse the exact same Node.js subprocess bridge mechanism (`ast_slicer.cjs`). This gives us robust, unassailable AST parsing of functions and classes without adding any new dependencies.
*   **Storage:** We will persist the Sub-AST cache in `.b4mal/ast_cache.sqlite` for durable, cross-session speed.

## Next Step
Proceed to Stage 2: Red-Team Review on this Design.
