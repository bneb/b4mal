# `src/`

The primary source directory for the `b4mal` orchestrator. It is strictly modular, ensuring clear separation of concerns.

- `core/`: The foundational primitives. Hashing, state ledgers, and formal mathematics.
- `orchestrator/`: The `Directed Acyclic Graph` parsing and execution engine.
- `remote/`: `Hypertext Transfer Protocol` caching and synchronization protocols.
- `discovery/`: Source code parsing via `Tree-sitter` for automated configuration generation.
- `cli/`: The `Command Line Interface` entry points.
- `reporter/`: Telemetry aggregation and visual output generation.
- `benchmarks/`: Synthetic stress tests ensuring hardware saturation.
