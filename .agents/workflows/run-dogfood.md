---
description: How to run the b4mal dogfood self-build pipeline
---

# /run-dogfood

Verifies that b4mal can build itself using its own CLI. Runs the 3-task pipeline
defined in `b4mal.lock` and confirms that both cold and hot cache passes work correctly.

## Prerequisites

- Bun v1.2+ installed
- Z3 SMT solver on PATH (for FormalShadow verification)
- From the `/Users/kevin/projects/b4mal` directory

## Steps

// turbo-all

1. Clean any previous dogfood DB and dist/ to start fresh:
```bash
export PATH="$HOME/.bun/bin:$PATH"
rm -f /tmp/dogfood-run.db && rm -rf dist/
```

2. Run Pass 1 — Cold build (all 3 tasks must execute, 0 cache hits):
```bash
B4MAL_DB_PATH=/tmp/dogfood-run.db bun src/cli/index.ts build
```
Expected output:
- `[OK] typecheck` ~1.2s (bunx tsc --noEmit)
- `[OK] test` ~600ms (formal_shadow + dag + performance tests)
- `[OK] build` ~8ms (bun build → dist/index.js)
- `Build complete. 3 tasks, 0 cache hits.`

3. Run Pass 2 — Hot cache (all 3 tasks must be cache hits):
```bash
B4MAL_DB_PATH=/tmp/dogfood-run.db bun src/cli/index.ts build
```
Expected output:
- `↩ typecheck (cached)`
- `↩ test (cached)`
- `↩ build (cached)`
- `Build complete. 3 tasks, 3 cache hits.`

4. Confirm dist/index.js was produced:
```bash
ls -lh dist/index.js
```

## Lockfile

The dogfood pipeline is declared in `/Users/kevin/projects/b4mal/b4mal.lock`.
The 3-task DAG:
- `typecheck` → `bunx tsc --noEmit` (reads: src/)
- `test` → `bun test formal_shadow dag performance` (reads: src/, tests/) depends: typecheck
- `build` → `bun build src/cli/index.ts --outdir dist` (reads: src/, writes: dist/) depends: typecheck, test

## Bun Test Suite

To run the full integration test version (slower, spawns child processes):
```bash
B4MAL_DB_PATH=/tmp/dogfood-test-$$.db bun test tests/dogfood.test.ts
```
Note: Pass 1 beforeAll timeout is 300s. On cold run expect ~5-10s total.
