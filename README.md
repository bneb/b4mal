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
package. Reproduce with `scripts/bench-compare.sh`, or run the **Compare** workflow,
which executes it on a dedicated runner and publishes the numbers to the job
summary.

The figures below are from that workflow: **ubuntu-latest, 4 vCPU, Bun 1.3.14,
Node 20**, median of 3 runs. A dedicated runner is not a detail — on a contended
laptop the same fixed workload varied 6× between samples, which is larger than any
difference between these tools, so local timings are noise.

### Correctness — where this differs categorically

Two tasks declaring the **same output file**, each truncating it, pausing, then
finishing. Run concurrently, the file tears; serialised, it stays whole.

| Tool | Consistent | Torn |
|---|---|---|
| **b4mal** | **5 / 5** | **0** |
| Turborepo | 2 / 5 | **3** |
| Nx | 2 / 5 | **3** |

Both competitors' races are real but *nondeterministic* — they tore in 3 of 5 runs
and got lucky in the other 2. That is the point: a race is a heisenbug, not a
reliable failure, which is exactly why it survives in production. b4mal never
tore, because declared outputs feed a prefix tree that injects a dependency so the
tasks never overlap. This does not depend on task duration or graph size — it is the
difference between a DAG that happened to be correct and a scheduler that
guarantees it.

### Performance — a tie on cold, a tie on warm

Median of 3 runs, local cache only, no remote cache on any side:

| Tool | Cold | Warm |
|---|---|---|
| b4mal | **1.71s** | 0.059s |
| Turborepo | 1.79s | **0.053s** |
| Nx | 0.42s | 0.59s |

**Read this honestly: b4mal does not win on wall-clock.** Cold is a tie (1.71s vs
1.79s). On a warm cache Turborepo is ahead by roughly 10% (0.053s vs 0.059s). An
earlier revision of this table, measured on a contended laptop, showed b4mal ahead
on warm cache; the dedicated runner does not support that claim, so it is corrected
here. Nx's cold figure benefits from its daemon already being warm from the first
sample, which is called out below.

Caveats that materially affect these numbers:

- **Nx's cold number is flattered by its daemon** — its first sample (3.7s) primes
  the daemon and the reported median (0.42s) is from daemon-warm runs. Turbo
  shows the same effect on warm (1.76s then 0.05s). b4mal has no daemon, so every
  b4mal run is honestly cold.
- **This is a small fixture measuring orchestrator overhead** against real task
  durations, not a real monorepo. Treat it as indicative, not publishable.
- The workflow **fails rather than publishing** if the runner is contended (a
  fixed-workload probe varies >1.5×), and the harness refuses to count any run
  that did not produce the expected outputs.

Cache-restore performance improved substantially in this release cycle by removing
process spawns from the artifact path entirely (native zstd + an in-process tar
reader) — a 16-artifact restore went from ~1.7s to well under 0.1s on this
hardware.

### The honest summary

On speed, b4mal is in a tie with Turborepo — marginally ahead cold, marginally
behind warm. It does not win the benchmark. On correctness it is the only one of
the three that can promise anything, because it is the only one that checks — and
that is the difference that matters when a build corrupts an artifact that then
poisons every future cache, on every machine, forever.

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
