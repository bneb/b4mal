# Coverage Report

## Target

>95% line+branch coverage on core operational code. UI/bootstrap/benchmark files excluded.

## Core Operational Files

These files run during `b4mal build` — the critical path:

| File | Line | Branch |
|------|------|--------|
| config_loader.ts | **100%** | **99%** |
| artifact_vault.ts | **100%** | **100%** |
| remote_vault.ts | **100%** | **100%** |
| s3_adapter.ts | **100%** | **100%** |
| prefix_tree.ts | 80% | **100%** |
| schema.ts | 95% | **96%** |
| content_hasher.ts | 95% | **99%** |
| engine.ts | 85% | **95%** |
| formal_shadow.ts | 85% | **96%** |
| planner.ts | 86% | **95%** |
| stream_engine.ts | 80% | **98%** |
| env_sanitizer.ts | 50% | **100%** |
| sqlite_ledger.ts | 78% | 84% |
| executor.ts | 73% | 74% |

**Weighted average (core only): ~88% line, ~94% branch**

## Excluded Files

These files are excluded from the coverage target because they're interactive tools, code generators, benchmarks, or language parsers that resist automated unit testing:

| File | Reason |
|------|--------|
| wizard.ts (38%/59%) | Interactive readline prompts |
| ci_emitter.ts (55%/40%) | YAML template generators |
| comment_stripper.ts (82%/89%) | Multi-language regex parser |
| normalizer_bench.ts (60%/73%) | Performance benchmark |
| logic_hasher.ts (67%/85%) | Bun Transpiler integration |
| tui_hud.ts (86%/—) | Terminal UI rendering |
| turbo_migrator.ts (67%/96%) | Requires real turbo.json fixtures |
| core_bootstrap.ts (86%/97%) | Requires openssl on PATH |
| attest.ts, demo.ts | CLI entry points |

## Improvement Plan

1. **executor.ts** (73%/74%): Mock tests for cache hit/miss paths, L2 interaction, error handling
2. **sqlite_ledger.ts** (78%/84%): Test legacy hash methods (currently uncalled but present)
3. **engine.ts** (85%/95%): Test plan() with collision scenarios, build with strict mode
4. **formal_shadow.ts** (85%/96%): Test attestation generation, SSE broadcast paths
5. **planner.ts** (86%/95%): Test claims overlap edge cases, cycle detection
