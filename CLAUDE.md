# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test                          # Full test suite (~70 files, 565 tests)
bun test tests/config_schema.test.ts   # Run a single test file
bun test --reporter=dot tests/    # Compact output for regression check
bunx tsc --noEmit                 # Type-check without emitting (required by CI)
bun run src/cli/index.ts build    # Self-hosted build (reads b4mal.lock)
bun run src/cli/index.ts demo     # Run the interactive collision-detection demo
bun run src/cli/index.ts init     # Auto-discover project structure, write b4mal.lock
```

The project uses **Bun** as both runtime and package manager. `bun build` compiles TypeScript to `dist/`. There is no `npm`, no `node`, and no separate bundler.

## Architecture

### The canonical data flow (build path)

```
b4mal.config.json  ──[config_loader]──>  B4malConfig  ──[configToTasks]──>  TaskConfigWithId[]
                                                                                    │
                                                                         writeLockfileAtomic()
                                                                                    │
                                                                                    ▼
b4mal.lock  ──[engine.normalizeLockTasks]──>  TaskConfigWithId[]  ──[conversion]──>  OrchestratorTask[]
                                                                                            │
                                                                              WavePlanner.planDAG()
                                                                                            │
                                                                                            ▼
                                                                                      DAGPlan
                                                                                            │
                                                                              DynamicExecutor.run()
                                                                                            │
                                                                              ┌── L1 cache check (SQLiteLedger + ArtifactVault)
                                                                              ├── L2 cache check (RemoteVault → S3Adapter) [NOT YET WIRED]
                                                                              ├── Execute (Bun.spawn with EnvSanitizer)
                                                                              ├── L1 pack (tar.zst via ArtifactVault.pack)
                                                                              └── L2 push (RemoteVault.pushWithMetadata) [NOT YET WIRED]
```

### The single engine

The CLI (`src/cli/index.ts`) uses `B4malEngine` from `src/core/engine.ts`. The orchestrator (`src/orchestrator/`) provides `WavePlanner` (DAG planning) and `DynamicExecutor` (task execution). The legacy engine (`src/engine.ts`, `src/cli.ts`, `src/dag.ts`, `src/runner.ts`, `src/cache.ts`) was removed — do not recreate these files.

### Type hierarchy

Three task types coexist. Know which is which:

| Type | Location | Used by | Has fields |
|------|----------|---------|------------|
| `TaskConfig` (Zod-inferred) | `src/schema.ts` | Config parsing | No `id` — key comes from record key |
| `TaskConfigWithId` (interface) | `src/schema.ts` | Config loader, lockfile I/O | Has `id`, `secrets?`, `when?` |
| `OrchestratorTask` (interface) | `src/orchestrator/planner.ts` | Planner, executor, engine verification | Has `id`, `deps` (not `dependencies`), `secrets?` |

The engine converts `TaskConfigWithId` → `OrchestratorTask` in `engine.build()` (lines ~145-160). This conversion drops `secrets` unless explicitly included — a previous bug where secrets were silently lost.

### Lockfile format

Two formats exist, both supported by `normalizeLockTasks()`:
- **Old (v1)**: Flat JSON array of task objects with `deps`, `reads`, `writes`, `envReads`, `envWrites`
- **New (v2)**: Envelope `{ "version": 2, "_meta": { "configHash": "sha256:..." }, "tasks": [...] }` with `dependencies`, `inputs`, `outputs`, `needsEnv`, `providesEnv`

`normalizeLockTasks()` handles both and produces canonical `TaskConfigWithId[]`.

### Resource claims and formal verification

The prefix tree (`src/formal/prefix_tree.ts`) detects overlapping filesystem and env claims between concurrent tasks in the same wave. Claims use protocol prefixes: `fs:dist/`, `env:PORT`, `db:primary`. If two tasks' claims overlap, the WavePlanner either serializes them (injects a synthetic dependency) or, if they're in the same wave, the FormalShadow reports a collision.

The verification model is set-theoretic: (W₁ ∩ (R₂ ∪ W₂)) = ∅ ∧ (W₂ ∩ (R₁ ∪ W₁)) = ∅

## Critical gotchas

- **Bun, not Node.** Use `Bun.spawn`, `Bun.file`, `Bun.CryptoHasher`, `Bun.write`. Avoid Node-specific APIs. `require()` works but is discouraged in ESM modules.

- **L2 cache is wired.** `RemoteVault` and `S3Adapter` are connected to `DynamicExecutor`. L2 is checked before L1 (shared cache is fresher), and results are pushed to L2 after successful L1 pack. All L2 failures are non-fatal. Set `B4MAL_CACHE_BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` to enable.

- **`--force` flag** — parsed by CLI, passed through engine to executor (`config.force`), skips both L2 and L1 cache when true.

- **`--concurrency` is propagated** from CLI → engine options → executor config.

- **Secrets were broken.** The `OrchestratorTask` interface lacked `secrets` — fixed in `96b1c9e`. Any new field added to `TaskConfigWithId` must also be added to `OrchestratorTask` and the conversion in `engine.build()`.

- **The `(t as any)` pattern.** The engine previously used `(t as any).reads` to access fields missing from `OrchestratorTask`. These were cleaned up but can reappear. If you see `as any` in the orchestrator path, a field is missing from a type.

- **Paths use forward slashes only.** `sanitizePath()` in schema.ts normalizes backslashes. Always use `/` in lockfiles for cross-platform determinism — even on Windows.

- **Symlink traversal protections exist** in `config_loader.ts` (loadConfig) and `artifact_vault.ts` (secureCopy). Both use `realpathSync` + path boundary checks. Do not weaken these.

- **The S3 adapter uses `Bun.S3Client` (built-in)**, not `@aws-sdk/client-s3`. The Bun client requires explicit keys — it does not use the AWS credential chain. Credentials come from env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `B4MAL_CACHE_BUCKET`.

## Code style

- **No YAML. No DSL.** Config files are JSON validated by Zod schemas (`src/schema.ts`). The codebase explicitly rejects YAML for configuration.
- **No classes for pure logic.** Functions are preferred. Classes exist only for stateful components (Engine, S3Adapter, RemoteVault, SQLiteLedger).
- **Zod for all user input.** Schema validation at every entry point. `B4malConfigSchema.parse()` before any config touches internal code.
- **Error handling:** `throw new Error("descriptive message")` — no custom error classes. CLI catches at the top level and prints `[FAIL]` with color.
- **Tests use Bun's built-in test runner.** `describe`/`test`/`expect` from `bun:test`. No Jest, no Mocha. Temporary directories via `mkdtempSync` + cleanup in `afterEach`.
