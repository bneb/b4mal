# B4mal

B4mal is a fast, deterministic build system and orchestrator for monorepos. It is designed around a strict mathematical model of task dependencies to guarantee reproducibility, parallel execution safety, and cache correctness.

## Design Philosophy

The core invariant of B4mal is determinism. If a task is executed with the exact same inputs, it must yield the exact same outputs. To achieve this, B4mal completely rejects implicit dependencies. Every file read, file write, and environment variable must be explicitly declared in the task configuration. 

If two tasks declare intersecting resource modifications without an explicit dependency edge, B4mal prevents them from executing in parallel using a strict path-based prefix tree lock.

## Key Features

- **Execution Sandboxing**: Failed tasks are isolated into an ephemeral `.b4mal/shadow` workspace, allowing you to debug and run diagnostics without contaminating your working tree.
- **Continuous-Flow DAG**: Tasks are compiled into a Directed Acyclic Graph (DAG) and executed in parallel where dependencies allow. Overlapping filesystem constraints automatically inject synthetic dependencies.
- **Zero-Trust Caching**: L1 (local) and L2 (remote) caching via exact content hashing. The `ArtifactVault` enforces OS-level file descriptor constraints to eliminate TOCTOU vulnerabilities and symlink breakouts.
- **Language Server Protocol (LSP)**: B4mal ships with a built-in LSP (`b4mal lsp`) to provide real-time editor feedback for resource collisions while editing configuration files.

## Installation

```bash
bun install -g b4mal
```

## Quick Start

Initialize B4mal in an existing project:

```bash
b4mal init
```

*Note: The migration wizard can automatically detect and translate legacy Turborepo, Nx, and Lerna configurations.*

Execute a build:

```bash
b4mal build
```

Analyze your build performance (requires modern browser for static HTML visualizer):

```bash
b4mal analyze
```

## Documentation

- [Core Engine](./src/core/README.md) - Deep dive into caching, validation, and formal verification.
- [Orchestrator](./src/orchestrator/README.md) - Dynamic scheduling, DAG planning, and subprocess isolation.
- [Architecture](./ARCHITECTURE.md) - Details on the internal engine mechanics and the DAG solver.
- [Benchmarks](./BENCHMARKS.md) - Apple M4 and Linux NVMe bare-metal performance metrics.

## Contributing

Pull requests are welcome. Ensure that you have read the architecture documents to understand the invariants governing the task executor. Run `bun test` to execute the full test suite before submitting.
