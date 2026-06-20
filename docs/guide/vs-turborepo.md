# b4mal vs. Turborepo

An honest comparison.

## TL;DR

| | b4mal | Turborepo |
|---|---|---|
| **Philosophy** | Correctness by construction | Speed by convention |
| **Learning curve** | Steeper — explicit declarations required | Shallow — package.json conventions |
| **Best for** | Teams that have been burned by cache bugs | Teams that want a fast on-ramp |
| **Cache model** | Logic-aware hashing (comments/whitespace/types don't invalidate) | File content hashing |
| **Conflict detection** | Prefix tree verifies every filesystem claim | None — relies on task-level deps |
| **Remote cache** | S3-compatible (BYO bucket) | Vercel-hosted (included) |
| **Polyglot** | Rust, Go, Python, TypeScript | TypeScript/JavaScript only |
| **Price** | Free, self-hosted | Free for personal, paid for teams |

## Where Turborepo wins

**Adoption speed.** `npx create-turbo` gives you a working monorepo in 30 seconds. B4mal requires you to declare every file input and output — better for correctness, worse for the first 5 minutes.

**Ecosystem.** Turborepo has Vercel integration, thousands of GitHub stars, community plugins, and first-class Next.js support. B4mal is new and has none of this.

**Simplicity.** Turborepo's mental model is "tasks with dependencies." B4mal's is "tasks claiming resources in a prefix tree." The former is easier to explain to a new teammate.

## Where b4mal wins

**Cache correctness.** B4mal's logic hashing ignores comments, whitespace, and TypeScript types. Reformat your codebase or add JSDoc? Turborepo invalidates every cache entry; B4mal doesn't.

**Concurrency safety.** B4mal formally proves that parallel tasks don't conflict on filesystem resources. Turborepo runs tasks in parallel and hopes you got the dependencies right. If task A writes to `dist/` and task B writes to `dist/bundle.js`, B4mal catches it; Turborepo doesn't.

**Deterministic shadowing detection.** If a downstream task overwrites an upstream task's output (e.g., both write to `dist/bundle.js`), B4mal reports it as wasted computation. Turborepo lets it happen silently.

**Polyglot support.** B4mal's init auto-detects Rust, Go, and Python projects and generates correct `cargo build`, `go build`, `pip install` commands. Turborepo is JS/TS-only.

**Cache security.** B4mal's artifact vault uses O_NOFOLLOW, inode verification, and symlink breakout prevention. Turborepo uses basic file hashing without these protections.

**Migration.** B4mal's wizard auto-translates `turbo.json` into a `b4mal.lock`. Going the other direction requires manual conversion.

## Migration path

If you're on Turborepo and curious:

1. `b4mal init` — auto-detects `turbo.json` and offers to migrate it
2. `b4mal build --dry-run` — see what B4mal would execute without running anything
3. `b4mal shadow` — check for deterministic overwrites in your current DAG
4. Run both side-by-side for a sprint before switching

You don't need to switch build systems to benefit from B4mal's correctness checks. `b4mal check` (planned) will read your lockfile and report collisions without executing anything — a correctness linter for your build graph.
