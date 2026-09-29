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

- **L1 Cache (Local)**: The ledger lives in the project at `.b4mal/cache.db`; artifact archives live in the user's home directory under `~/.b4mal/artifacts/<sha256(projectRoot)>/`. Artifacts are compressed using Zstandard (`zstd`) for high throughput. Note that the vault is keyed by the project's absolute path, so a relocated checkout does not reuse its previous archives.
- **L2 Cache (Remote)**: Enabled by environment variables — set `B4MAL_CACHE_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and optionally `AWS_REGION`) to synchronize artifacts to an S3-compatible backend. There is no `b4mal login` command.

A `ContentHasher` generates deterministic signatures for each task. The hash function inputs include:
- The task command and arguments.
- The exact file contents of all declared `reads` (excluding any path the task itself declares as an output).
- The values of all declared `needsEnv` variables.

A task's own declared outputs are deliberately **excluded** from its key: including them made the key depend on the content of the file the task writes, so the key changed as a consequence of the task running.

## Execution Sandboxing

**Not implemented.** B4mal does not currently isolate failed tasks: a failing task leaves whatever it wrote in place, and its transitive dependents are skipped rather than executed. There is no `.b4mal/shadow/<taskId>` clone-on-failure workspace, and no `BuildDoctor` component exists. `src/guard/sandbox.ts` provides a standalone `SandboxEngine.wrapCommand` helper, but nothing calls it.
