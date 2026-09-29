# Coverage Report

## Target

>95% line+branch coverage on core operational code. UI/bootstrap/benchmark files excluded.

**This table is measured, not aspirational.** Reproduce with:

```bash
bun test --coverage
```

Last measured against `bun test` (570 tests, 62 files) on the commit that fixed the
planner-mutation and cache-key defects. If you change the code, re-run the command
and update the numbers rather than the other way round.

## Core Operational Files

These files run during `b4mal build` — the critical path:

| File | Line | Branch | Uncovered |
|------|------|--------|-----------|
| config_loader.ts | **100%** | **99.4%** | — |
| artifact_vault.ts | **100%** | **100%** | — |
| remote_vault.ts | **100%** | **100%** | — |
| s3_adapter.ts | **100%** | **100%** | — |
| cache_key.ts | **100%** | **100%** | — |
| schema.ts | 94.7% | 95.3% | 130-134 |
| content_hasher.ts | 94.7% | 99.2% | — |
| sqlite_ledger.ts | 88.9% | 95.8% | 159-161 |
| formal_shadow.ts | 86.7% | 96.6% | 64, 150-155 |
| executor.ts | 85.7% | 88.0% | 182-183, 233-246, 263, 273, 364-367, 387-396 |
| planner.ts | 83.3% | 95.5% | 79, 103, 131, 139-143 |
| prefix_tree.ts | 80.0% | **100%** | — |
| stream_engine.ts | 80.0% | 97.6% | — |
| engine.ts | 77.1% | 85.5% | 102-114, 126-134, 147-157, 217-224 |
| env_sanitizer.ts | 50.0% | **100%** | — |

**Core average: 88.1% line, 96.9% branch.**

For reference, the whole `src/` tree measures **80.6% line / 90.6% branch** — that
figure includes the interactive tools and language ingesters listed below, which
are excluded from the core target because they are not on the build path.

## Excluded Files

Excluded from the core target because they are interactive tools, code generators,
benchmarks, or language parsers that resist automated unit testing:

| File | Line | Reason |
|------|------|--------|
| wizard.ts | 37.5% | Interactive readline prompts |
| ci_emitter.ts | 90.9% | YAML template generators |
| comment_stripper.ts | 81.8% | Multi-language regex parser |
| normalizer_bench.ts | 60.0% | Performance benchmark |
| logic_hasher.ts | 100% | Bun Transpiler integration |
| tui_hud.ts | 85.7% | Terminal UI rendering |
| turbo_migrator.ts | 66.7% | Requires real turbo.json fixtures |
| core_bootstrap.ts | 85.7% | Requires openssl on PATH |
| cargo_ingester.ts | 20.0% | Rust workspace fixtures |
| auto_map.ts | 33.3% | Project auto-discovery heuristics |
| npm_migrator.ts | 50.0% | Workspace-glob fixtures |
| attest.ts, demo.ts | — | CLI entry points |

## Improvement Plan

1. **engine.ts** (77.1%/85.5%): the lowest-covered file on the build path. Cover
   `strict` mode, L2 wiring, and the `init` discovery branches (102-157).
2. **executor.ts** (85.7%/88.0%): the `when` conditional branches (233-246) and
   the L2 push path (387-396).
3. **env_sanitizer.ts** (50.0%/100%): every branch is covered but half the lines
   are not — the whitelist loop is only exercised for a subset of keys.
4. **planner.ts** (83.3%/95.5%): cycle detection (79) and the forecaster sort (131).
5. **prefix_tree.ts** (80.0%/100%): uncovered lines are the directory-containment
   fast paths; branch coverage is already complete.
