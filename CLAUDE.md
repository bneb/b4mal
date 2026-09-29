# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun test                          # Full test suite (67 files, 628 tests)
bun test tests/config_schema.test.ts   # Run a single test file
bun test --reporter=dot tests/    # Compact output for regression check
bunx tsc --noEmit                 # Type-check without emitting (required by CI)

# Build & run
bun run build                     # Compile CLI to dist/index.js (bun build --target bun)
bun run src/cli/index.ts build    # Self-hosted build (reads b4mal.lock)
bun run src/cli/index.ts demo     # Run the interactive collision-detection demo
bun run src/cli/index.ts init     # Auto-discover project structure, write b4mal.lock
bun run src/cli/index.ts attest t fs:write:dist   # Normalized resource claim (JSON)

# Docs
bun run docs:dev                  # Start vitepress dev server
bun run docs:build                # Build static docs site
bun run docs:preview              # Preview built docs site

# Publishing
bun publish                       # Publish to npm (runs build + test first)
bun run scripts/benchmark-init.ts # Test init against 35 real repos (scores GREEN/YELLOW/RED)
cargo test --manifest-path crates/b4mal/Cargo.toml   # Rust integration crate

# Sprint tracking
# Active sprint: artifacts/plans/sprint-go-to-market.md
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
                                                                              ├── L2 cache check (RemoteVault → S3Adapter)
                                                                              ├── Execute (Bun.spawn with EnvSanitizer)
                                                                              ├── L1 pack (tar.zst via ArtifactVault.pack)
                                                                              └── L2 push (RemoteVault.pushWithMetadata)
```

### The single engine

The CLI (`src/cli/index.ts`) uses `B4malEngine` from `src/core/engine.ts`. The orchestrator (`src/orchestrator/`) provides `WavePlanner` (DAG planning) and `DynamicExecutor` (task execution). The legacy engine (`src/engine.ts`, `src/cli.ts`, `src/dag.ts`, `src/runner.ts`, `src/cache.ts`) was removed — do not recreate these files.

### Type hierarchy

Three task types coexist. Know which is which:

| Type | Location | Used by | Has fields |
|------|----------|---------|------------|
| `TaskConfig` (Zod-inferred) | `src/schema.ts` | Config parsing | No `id` — key comes from record key |
| `TaskConfigWithId` (interface) | `src/schema.ts` | Config loader, lockfile I/O | Has `id`, `secrets?`, `when?` |
| `OrchestratorTask` (interface) | `src/orchestrator/planner.ts` | Planner, executor, engine verification | Has `id`, `deps` (not `dependencies`), `secrets?`, `envReads?`, `envWrites?` |

The engine converts `TaskConfigWithId` → `OrchestratorTask` in **both** `engine.plan()` and `engine.build()`. Every field the executor or planner needs must appear in both conversions — dropping one is how the `secrets` bug and the `needsEnv` bug happened.

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

- **L2 cache is wired and tested.** `RemoteVault` and `S3Adapter` are connected to `DynamicExecutor`. L2 is checked before L1 (shared cache is fresher), and results are pushed to L2 after a successful L1 pack. All L2 failures are non-fatal — including a rejected signature, which becomes a miss so the task re-executes. Enable with `B4MAL_CACHE_BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`; optional `AWS_REGION`, `AWS_S3_ENDPOINT` (MinIO, R2, B2 — the adapter is path-style), and `B4MAL_CACHE_ORG` (key prefix for sharing one bucket between tenants). `tests/remote_cache_l2.test.ts` drives the real CLI against an in-memory S3 stub (`tests/fixtures/s3_stub.ts`) — no credentials or network needed.

- **A remote cache hit must unpack, not just promote.** `RemoteVault.checkAndPull` promotes the downloaded archive into the L1 vault, but promoting only *writes* the archive. The executor has to call `ArtifactVault.unpack` for the task's files to reappear, and must record a ledger entry so the promoted copy is usable without going back to the network. Both were missing; an L2 hit used to report success with the declared outputs absent.

- **Remote artifacts are only authenticated when `B4MAL_CACHE_SECRET` is set.** Pushes then embed an HMAC-SHA256 over `<logicHash>:<sha256 of payload>` and pulls verify it, treating a failure as a miss. Without the secret the remote cache is unauthenticated by design and the docs say so — do not describe it as verified. `ArtifactCrypto` (`src/core/crypto.ts`) is the single place that signs and checks; keep it that way rather than signing at call sites.

- **`--force` flag** — parsed by CLI, passed through engine to executor (`config.force`), skips both L2 and L1 cache when true.

- **`--concurrency` is propagated** from CLI → engine options → executor config.

- **Secrets were broken.** The `OrchestratorTask` interface lacked `secrets` — fixed in `96b1c9e`. Any new field added to `TaskConfigWithId` must also be added to `OrchestratorTask` and the conversion in `engine.build()`.

- **The `(t as any)` pattern.** The engine previously used `(t as any).reads` to access fields missing from `OrchestratorTask`. These were cleaned up but can reappear. If you see `as any` in the orchestrator path, a field is missing from a type.

- **Paths use forward slashes only.** `sanitizePath()` in schema.ts normalizes backslashes. Always use `/` in lockfiles for cross-platform determinism — even on Windows.

- **Symlink traversal protections exist** in `config_loader.ts` (loadConfig) and `artifact_vault.ts` (secureCopy). Both use `realpathSync` + path boundary checks. Do not weaken these.

- **The S3 adapter uses `Bun.S3Client` (built-in)**, not `@aws-sdk/client-s3`. The Bun client requires explicit keys — it does not use the AWS credential chain. Credentials come from env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `B4MAL_CACHE_BUCKET`.

- **`planDAG` must not mutate the caller's tasks.** It used to write its normalized access view back onto `t.reads`/`t.writes`/`t.claims`, folding every `fs:` claim into *both* reads and writes. Those same objects are handed to the executor, which uses `reads` for the cache key and `writes` for artifact packing — so declared inputs were archived as artifacts and dropped from cache keys. The planner now keeps its normalized view in a local `accessMap`. `tests/planner_purity.test.ts` guards this.

- **A task's own outputs must never enter its cache key.** `task.claims` is built as `inputs + outputs + explicit claims`, so hashing it directly made the key depend on the content of the file the task writes: the key changed *because the task ran*. `computeCacheKey` in `src/orchestrator/cache_key.ts` hashes only declared inputs (command, `reads`/`claims` minus `writes`, and declared `needsEnv` values). `CACHE_KEY_VERSION` salts the key — bump it whenever the hashed input set changes, or old entries can be read back as hits under a different scheme.

- **Declared env vars reach the task through `envReads`.** `needsEnv` from the lockfile is plumbed to `OrchestratorTask.envReads` in both `engine.plan()` and `engine.build()`. It feeds both the `EnvSanitizer` allow-list and the cache key. If you add a `TaskConfigWithId` field, add it to `OrchestratorTask` *and* both engine conversions — the secrets bug and the `needsEnv` bug were both this mistake.

- **Scheduling is fail-fast.** In `DynamicExecutor.run`, a task whose `exitCode !== 0` must not decrement its dependents' in-degrees. Dependents are marked `skipped: true` (with `exitCode: 1`) transitively instead. `settleIfComplete` resolves on `settled.size === totalTasks`, so skipped tasks still count toward completion. `tests/failfast.test.ts` covers this.

- **`ArtifactVault.pack` writes to a scratch path and renames.** `zstd -o <existing>` refuses to overwrite when stdin is a pipe, so writing straight to the archive path made re-packing any hash impossible; the scratch+rename also prevents a truncated archive from being restored as corrupt output by a later hit.

- **Never pipe `zstd --stdout` into `tar` in the same process tree.** `tar` stops reading at the end-of-archive marker, closing the pipe while zstd still writes; the resulting EPIPE surfaces as an *unhandled rejection* (the inner child's stream is never drained) and kills the CLI. `unpack` decompresses to a file first.

- **`B4MAL_DB_PATH` overrides the ledger path** (`SQLiteLedger` constructor). Used by `tests/dogfood.test.ts` and `tests/cli_integration.test.ts` for cache isolation. Without it those tests write to the project's real `.b4mal/cache.db`.

## Code style

- **No YAML. No DSL.** Config files are JSON validated by Zod schemas (`src/schema.ts`). The codebase explicitly rejects YAML for configuration.
- **No classes for pure logic.** Functions are preferred. Classes exist only for stateful components (Engine, S3Adapter, RemoteVault, SQLiteLedger).
- **Zod for all user input.** Schema validation at every entry point. `B4malConfigSchema.parse()` before any config touches internal code.
- **Error handling:** `throw new Error("descriptive message")` — no custom error classes. CLI catches at the top level and prints `[FAIL]` with color.
- **Tests use Bun's built-in test runner.** `describe`/`test`/`expect` from `bun:test`. No Jest, no Mocha. Temporary directories via `mkdtempSync` + cleanup in `afterEach`.
