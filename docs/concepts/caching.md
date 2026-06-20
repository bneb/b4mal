# Caching

B4mal uses a two-tier cache architecture with cryptographic verification at every layer.

## Cache layers

### L1: Local cache

Stored in `~/.b4mal/artifacts/<project-hash>/`. Each cached task result is a zstd-compressed tar archive containing the task's declared output files, plus an embedded JSON header with metadata (exit code, duration, task ID).

Cache hits are verified by comparing the task's **logic hash** (computed from declared inputs) against the SQLite ledger. If the hash matches and the artifact archive exists, the task is restored from cache without re-execution.

### L2: Remote cache (S3-compatible)

When `B4MAL_CACHE_BUCKET` and AWS credentials are configured, B4mal checks the remote cache **before** the local cache. Shared results from CI teammates are fresher than local results. On a successful task execution, the artifact is pushed to both L1 and L2.

All L2 failures are non-fatal — builds proceed with local execution if the remote is unreachable.

## Cache security

B4mal's artifact vault enforces multiple layers of security:

- **O_NOFOLLOW** — files are opened without following symlinks
- **TOCTOU protection** — inode and device IDs are verified after opening to detect swap attacks
- **Symlink breakout prevention** — all paths are resolved to canonical form and verified to be within the project root
- **Path traversal rejection** — archive contents are listed and validated before extraction; any path containing `..` or starting with `/` is rejected

## Logic hashing

Instead of hashing raw file contents (which would invalidate the cache on whitespace or comment changes), B4mal can hash at the **logic level**:

- TypeScript → transpiled to JavaScript (types erased), whitespace normalized → SHA-256
- Rust/Go/Python → comments stripped → SHA-256
- Non-code files (JSON, YAML, Markdown) → full content SHA-256

This means changing documentation comments or reformatting code does not invalidate the cache.

## Cache lifecycle

- **`b4mal clean`** — purges all local cache entries and the SQLite ledger
- **`--force`** / `-f` — skips both L2 and L1 cache, forces full re-execution
- **`cache: false`** — per-task opt-out from caching (for inherently non-deterministic tasks)
