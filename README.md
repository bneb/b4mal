# B4mal

B4mal is a fast, deterministic build system and orchestrator for monorepos. It is designed around a strict model of task dependencies to guarantee reproducibility, parallel execution safety, and cache correctness.

> **Requires [Bun](https://bun.sh).** B4mal is deliberately Bun-only. Prebuilt release
> binaries are self-contained and need no runtime install; installing from npm still
> requires Bun to be available at runtime.

## Design Philosophy

The core invariant of B4mal is determinism. If a task is executed with the exact same inputs, it must yield the exact same outputs. To achieve this, B4mal completely rejects implicit dependencies. Every file read, file write, and environment variable must be explicitly declared in the task configuration.

If two tasks declare intersecting resource modifications without an explicit dependency edge, B4mal prevents them from executing in parallel using a strict path-based prefix tree lock.

## Key Features

- **Resource-isolated scheduling**: Declared filesystem and environment access is checked before execution. Two tasks whose claims overlap are serialized rather than raced, and the prefix tree understands directory/file containment (`dist/` overlaps `dist/main.js`, but `src/db` does not overlap `src/db_backup`).
- **DAG audit — `b4mal check`**: Verifies a lockfile without executing anything. It reports resource collisions, deterministic overwrites ("shadowing"), and undeclared producer/consumer pairs. Shadowing is audited across *every* pair of tasks, not only pairs already linked by a dependency chain — two independent tasks declaring the same output are reported even though the planner silently orders them with a synthesized edge.
- **Verified caching**: L1 (local SQLite ledger + artifact vault) and L2 (remote object storage). A cache key is a pure function of a task's declared inputs — its command, its declared `reads`, and the values of its declared `needsEnv` variables. A task's own declared outputs never contribute to its key, so leftover or externally modified build products cannot change whether the cache hits. The `ArtifactVault` enforces OS-level file descriptor constraints to eliminate TOCTOU vulnerabilities and symlink breakouts.
- **Fail-fast scheduling**: When a task fails, its transitive dependents are skipped and the build exits non-zero, instead of running downstream work against inputs that were never produced.
- **Strict environment isolation**: Subprocesses receive only a minimal POSIX whitelist plus the variables the task explicitly declares. Undeclared variables never reach the child process.
- **Continuous-Flow DAG**: Tasks are compiled into a Directed Acyclic Graph (DAG) and executed in parallel where dependencies allow. Overlapping filesystem constraints automatically inject synthetic dependencies.
- **Language Server Protocol (LSP)**: B4mal ships with a built-in LSP (`b4mal lsp`) to provide real-time editor feedback for resource collisions while editing configuration files.

## Installation

The CLI runs on the [Bun](https://bun.sh) runtime, and the published entry point is a Bun script — **install Bun first**, whichever installer you use.

```bash
bun install -g @bneb/b4mal
```

`npm install -g @bneb/b4mal` also works for placing the binary on your `PATH`, but Bun must still be available at runtime.

## Quick Start

Define your tasks in `b4mal.config.json`:

```json
{
  "tasks": {
    "typecheck": { "cmd": ["bunx", "tsc", "--noEmit"], "inputs": ["src"] },
    "test":      { "cmd": ["bun", "test"], "inputs": ["src", "tests"], "dependencies": ["typecheck"] },
    "build":     { "cmd": ["bun", "build"], "inputs": ["src"], "outputs": ["dist"], "dependencies": ["test"] }
  }
}
```

Then audit and run it:

```bash
b4mal check          # verify the DAG without executing anything
b4mal build          # prove + execute, cache-aware
b4mal build --sync   # force-regenerate b4mal.lock from b4mal.config.json
b4mal analyze        # static HTML observability dashboard
```

`b4mal init` auto-discovers an existing project and writes **both** files: `b4mal.config.json` (which you edit) and `b4mal.lock` (generated from it). Task ids are normalised — an npm script named `test:unit` becomes the task `test-unit` while still running `npm run test:unit`. The migration wizard translates legacy Turborepo, Nx, and Lerna configurations.

### Audit a build graph in CI, without switching build systems

`b4mal check` reports resource collisions, deterministic overwrites, and implicit
dependencies without running anything. As a GitHub Action it is a few lines and a
no-op on repositories that do not use b4mal:

```yaml
- uses: bneb/b4mal@v0.1.2
  with:
    fail-on-findings: false   # start by reporting, not gating
```

See [Installation](https://github.com/bneb/b4mal/blob/main/docs/guide/installation.md#github-action) for inputs and outputs.

### Autonomous Trace Synthesis

B4mal can automatically synthesize a mathematically sound DAG by passively tracing a legacy build script's file descriptor usage:

```bash
b4mal trace "npm run build"
```

**Platform Requirements for Tracing**:
The `trace` command intercepts `execve`, `openat`, and `clone` system calls via Linux tracing primitives (`strace`/eBPF).
- **Linux / CI**: Runs natively (e.g., GitHub Actions Ubuntu runners).
- **Docker**: Requires the `--cap-add=SYS_PTRACE` flag to allow system call interception.
- **macOS / Windows**: Native tracing is unsupported due to OS-level restrictions (SIP). Run the trace step inside a Linux container.

*Note: Once `b4mal.ts` is synthesized, the resulting DAG can be executed (`b4mal build`) natively on any OS.*

## Comparisons

Measured against Turborepo and Nx on an identical fixture: 8 packages × (build +
test) = 16 tasks, each doing non-elidable work (SHA-256 over 256KB) seeded per
package. Reproduce with `scripts/bench-compare.sh`.

### Correctness — where this differs categorically

Two tasks declaring the **same output file**, each truncating it, pausing, then
finishing. Run concurrently, the file tears; serialised, it stays whole.

| Tool | Result |
|---|---|
| **b4mal** | **5 / 5 consistent** |
| Turborepo | 2 consistent / **3 torn** of 5 |
| Nx | not measured — the harness could not drive its writers |

Turborepo's race is real but *nondeterministic*: it tore the file in 3 of 5 runs and
happened to get lucky in the other 2. That is the point — a race is a heisenbug, not
a reliable failure. b4mal never tore, because declared outputs feed a prefix tree
that injects a dependency so the tasks never overlap. This does not depend on task
duration or graph size: it is the difference between a DAG that happened to be
correct and a scheduler that guarantees it.

(Nx is listed as not measured because the harness's Nx wiring does not currently
execute its writer tasks; we would rather say so than publish a zero.)

### Performance — at parity, and ahead on warm cache

Median of 3 runs, local cache only, no remote cache on any side. Three independent
harness runs; the warm-cache column is the stable signal.

| Tool | Cold | Warm |
|---|---|---|
| **b4mal** | 1.7 – 2.1s | **0.14 – 0.16s** |
| Turborepo | 1.5 – 4.1s | 0.16 – 0.18s |
| Nx | 0.9 – 1.6s | 0.65 – 0.81s |

**b4mal is competitive on cold and now marginally ahead of Turborepo on a warm
cache.** An earlier revision of this table reported b4mal at 0.39s warm and
Turborepo ~2× faster; removing the last `tar` process spawns closed that gap.

Three caveats that materially affect these numbers:

- **Cold figures are noisy on this machine** (Turbo ranged 1.5–4.1s across runs,
  largely daemon start-up). Treat cold as a tie within noise; warm is the number
  that reproduces.
- **Turbo and Nx keep daemons warm between runs.** Their second and third "cold"
  runs are daemon-warm; b4mal has no daemon, so every cold run is honestly cold.
  Nx's true first run can exceed 20s.
- **This is a small fixture on one machine** (Apple M4, 10 cores). It measures
  orchestrator overhead against real task durations, not a real monorepo. Treat it
  as indicative, not publishable.

Warm-restore performance was improved substantially in this release cycle by
removing process spawns from the artifact path entirely (native zstd + an in-process
tar reader), taking a 16-artifact cache restore from ~1.7s to ~0.15s.

### The honest summary

On speed, b4mal is at parity on a cold build and now marginally ahead of Turborepo
on a warm cache. On correctness it is the only one of the three that can promise
anything, because it is the only one that checks — and that is the difference that
matters when a build corrupts an artifact that then poisons every future cache.

## Not Yet Implemented

Documented in some design notes in this repository, but **not implemented in the code**. Do not rely on these:

- **Failure sandboxing.** There is no `.b4mal/shadow/<taskId>` clone-on-failure workspace. A failing task leaves whatever it wrote in place; its dependents are skipped, but nothing is snapshotted for offline diagnosis. (`src/guard/sandbox.ts` exists as an unused standalone helper that nothing calls.)
- **`BuildDoctor`.** Referenced in `ARCHITECTURE.md`; no such component exists.
- **Native `trace` on macOS / Windows.** Linux-only, as noted above.

## Documentation

- [Roadmap](./ROADMAP.md) - Open work, and what is verified versus merely claimed.
- [Core Engine](./src/core/README.md) - Deep dive into caching, validation, and formal verification.
- [Orchestrator](./src/orchestrator/README.md) - Dynamic scheduling, DAG planning, and subprocess isolation.
- [Architecture](./ARCHITECTURE.md) - Details on the internal engine mechanics and the DAG collision engine.
- [Benchmarks](./BENCHMARKS.md) - Apple M4 and Linux NVMe bare-metal performance metrics.

## Contributing

Pull requests are welcome. Ensure that you have read the architecture documents to understand the invariants governing the task executor. Run `bun test` to execute the full test suite, and `bunx tsc --noEmit` to type-check, before submitting.
