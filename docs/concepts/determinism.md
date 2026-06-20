# Determinism

B4mal's core invariant: **given the same inputs, a task always produces the same outputs**. This enables correct caching, safe parallelism, and auditable builds.

## How it works

B4mal rejects all forms of implicit dependency. Every task must declare:

- **File reads** (`inputs`) — every file the task opens for reading
- **File writes** (`outputs`) — every file the task creates or modifies
- **Environment reads** (`needsEnv`) — every environment variable the task accesses
- **Secrets** (`secrets`) — sensitive values injected at runtime but excluded from cache keys

Before execution, B4mal computes a **logic hash** from the declared inputs: the command, the content of every input file, and the values of every declared environment variable. This hash becomes the cache key.

## Why determinism matters

Without explicit declarations, build tools rely on convention — they trust that you've correctly specified your dependencies. If you miss one, the cache returns stale results silently.

B4mal's explicit model means:

1. **Cache hits are provably correct** — if the logic hash matches, the outputs are guaranteed identical
2. **Parallelism is safe** — two tasks can run concurrently if they don't share resources
3. **Builds are reproducible** — the same inputs always produce the same artifact

## What about non-deterministic tools?

Some tools are inherently non-deterministic (e.g., code generators with timestamps, UUID generators). B4mal handles these through the `cache: false` option, which skips caching for that task while still verifying its resource declarations.
