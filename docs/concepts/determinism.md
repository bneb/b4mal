# Determinism

B4mal's core invariant: **given the same inputs, a task always produces the same outputs**. This enables correct caching, safe parallelism, and auditable builds.

## How it works

B4mal rejects all forms of implicit dependency. Every task must declare:

- **File reads** (`inputs`) — every file the task opens for reading
- **File writes** (`outputs`) — every file the task creates or modifies
- **Environment reads** (`needsEnv`) — every environment variable the task accesses
- **Secrets** (`secrets`) — sensitive values injected at runtime but excluded from cache keys

Before execution, B4mal computes the cache key from the declared inputs alone: the command, the content of every input file, and the values of every declared environment variable. A task's own declared `outputs` are deliberately **excluded** — including them made the key depend on the content of the file the task writes, so the key changed as a consequence of the task running.

Inputs are hashed in one of two modes. Tasks that declare no outputs (typecheck, test) use an AST-normalized "logic" hash, so comment-only edits don't invalidate them. Tasks that produce artifacts are keyed on raw input content.

## Why determinism matters

Without explicit declarations, build tools rely on convention — they trust that you've correctly specified your dependencies. If you miss one, the cache returns stale results silently.

B4mal's explicit model means:

1. **Cache hits are correct when the declarations are complete** — a matching key implies identical declared inputs, so the outputs are reproduced rather than re-derived. This is a guarantee about the model, not a free pass: an input you forgot to declare is an input the key cannot see, and the cache will happily return a stale result for it. The same failure mode described above applies to B4mal if a task under-declares.
2. **Parallelism is safe** — two tasks can run concurrently if their declared resources don't overlap; overlapping claims are serialized.
3. **Builds are reproducible** — the same declared inputs produce the same artifact, provided the underlying tool is itself deterministic.

## What about non-deterministic tools?

Some tools are inherently non-deterministic (e.g., code generators with timestamps, UUID generators). B4mal handles these through the `cache: false` option, which skips caching for that task while still verifying its resource declarations.
