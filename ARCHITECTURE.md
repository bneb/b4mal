# B4mal Architecture

This document describes the internal architecture of B4mal, the core orchestration engine, and the constraints governing execution.

## The Engine (`B4malEngine`)

B4mal operates on a phased compilation and execution model:

1. **Discovery & Ingestion**: The system ingests standard lockfiles (e.g., `b4mal.lock`), translating them into discrete `OrchestratorTask` definitions.
2. **Topological Planning (`WavePlanner`)**: Tasks are assembled into a Directed Acyclic Graph (DAG). A topological sort groups independent tasks into execution "waves".
3. **Resource Collision Detection**: Before any wave executes, the `WavePlanner` inserts all declared file paths and environment variables into a `PrefixTree`. If two tasks in the same wave attempt to write to overlapping paths (e.g., `dist/` and `dist/bundle.js`), the engine splits the wave to prevent race conditions.
4. **Execution (`DynamicExecutor`)**: Tasks are dispatched. If a task's hash matches an existing L1 or L2 cache entry, it is immediately skipped, and the artifact is decompressed from the `ArtifactVault`.

## The Cache Hierarchy

B4mal utilizes a dual-layer caching architecture:

- **L1 Cache (Local)**: Stored in `.b4mal/artifacts/`. Artifacts are compressed using Zstandard (`zstd`) for high throughput.
- **L2 Cache (Remote)**: Configured via `b4mal login`. Artifacts are seamlessly synchronized to an S3-compatible backend. 

A `ContentHasher` generates deterministic signatures for each task. The hash function inputs include:
- The task command and arguments.
- The exact file contents of all declared `reads`.
- The values of all declared `env` variables.

## Execution Sandboxing

B4mal does not allow broken builds to leave artifacts in the primary workspace. When a task fails, B4mal automatically isolates the failure by creating a clone of the working tree in `.b4mal/shadow/<taskId>`.

This allows debugging tooling (such as the `BuildDoctor`) to safely diagnose the failure, modify files, and propose fixes without risking repository corruption.
