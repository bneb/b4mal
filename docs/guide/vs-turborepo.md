# b4mal vs. Turborepo

Turborepo is a mature, widely used build system. This page describes where the two
differ; it is written from B4mal's side and is not a benchmark.

**What has not been tested here.** No head-to-head measurement against Turborepo was
run for this page. Statements below about Turborepo describe its documented design
and should be checked against Turborepo's own documentation before you rely on them —
especially pricing and hosting details, which change. Claims about B4mal were
verified against this repository's code and test suite.

## TL;DR

| | b4mal | Turborepo |
|---|---|---|
| **Philosophy** | Correctness by construction — tasks declare their inputs and outputs | Convention-driven — tasks discovered from `package.json` |
| **Learning curve** | Steeper: undeclared access is not tracked | Shallow: works on an existing JS/TS monorepo quickly |
| **Cache key** | Command + declared inputs + declared env values. AST-normalized for tasks with no outputs | Content hashing of declared inputs |
| **Resource conflicts** | Path-prefix tree over declared claims; overlapping claims are serialized | Task-level dependency graph |
| **Remote cache** | S3-compatible, bring your own bucket (L2 is wired but untested here — no credentials) | Vercel-hosted remote cache |
| **Polyglot** | Rust, Go, Python, TypeScript/JavaScript | JavaScript/TypeScript focused |
| **Neither is** | A drop-in replacement for the other | — |

## Where Turborepo wins

**Time to first build.** `npx create-turbo` gets a working monorepo running in a
minute. B4mal requires declaring file inputs and outputs first — better for
correctness, slower for the first five minutes.

**Ecosystem and maturity.** Turborepo has years of production use, deep Vercel
integration and first-class Next.js support. B4mal is new, has a single maintainer,
and its L2 cache path has not been exercised against real object storage.

**Simplicity.** "Tasks with dependencies" is easier to explain to a new teammate than
"tasks claiming resources in a prefix tree."

## Where b4mal differs

**Cache key composition.** For tasks that declare no outputs (`typecheck`, `test`),
B4mal hashes inputs by AST, so comment-only and formatting-only edits do not
invalidate the cache. Tasks that produce artifacts are keyed on raw input content,
so a reformat *does* invalidate those. A task's own declared outputs are excluded
from its key, so leftover build products cannot change whether it hits.

**Undeclared-producer detection.** `b4mal check` audits every pair of tasks — not only
pairs already linked by a dependency chain — and reports deterministic overwrites
("shadowing") and undeclared producer/consumer pairs. It exits non-zero, so it works
as a linter over a build graph.

**Fail-fast scheduling.** A failed task's transitive dependents are skipped rather
than executed against inputs that were never produced.

**Polyglot init.** `b4mal init` detects Rust, Go and Python projects and generates
`cargo` / `go` / `pip` commands. Verified across 35 real repositories — see
[Benchmark Results](/guide/benchmark-results) — where 34 are GREEN and one is
YELLOW.

**Artifact handling.** The vault copies through bounded file descriptors with
`O_NOFOLLOW` and inode/device verification, and writes archives to a scratch path
before renaming them into place.

**Migration.** `b4mal init` detects `turbo.json` and can translate it into a
`b4mal.lock` via `TurboMigrator`. The reverse direction has no tooling.

## A caveat that applies to B4mal

B4mal's guarantees are conditional on your declarations being complete. If a task
reads a file it never declared, no cache key can see that file, and the cache will
return a stale result — the same failure mode this comparison attributes to
convention-based tools. B4mal makes under-declaration *visible* (`check` reports
undeclared producer/consumer pairs) but it cannot detect access that was never
declared at all.

## Migration path

If you're on Turborepo and curious:

1. `b4mal init` — detects `turbo.json` and offers to migrate it
2. `b4mal build --dry-run` — print the planned waves without executing anything
3. `b4mal check` — report collisions and deterministic overwrites without executing
4. Run both side-by-side for a sprint before switching

You don't have to switch build systems to use the audit. `b4mal check` reads a
lockfile and reports conflicts without running your build.
