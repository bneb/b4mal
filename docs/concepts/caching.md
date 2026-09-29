# Caching

B4mal uses a two-tier cache architecture: a local artifact vault, and an optional S3-compatible remote.

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

### Authenticating remote artifacts

Remote entries are signed when a secret is configured:

```bash
export B4MAL_CACHE_SECRET="a-long-random-string"
```

With it set, every push embeds an HMAC-SHA256 signature over
`<logicHash>:<sha256 of the payload>`, and every pull verifies it before anything
touches the workspace. A missing, malformed or wrong signature makes the artifact a
**miss** — the task re-executes rather than restoring contents the bucket operator
could have chosen. That is the safe outcome, and it is not a build failure.

The signature covers the logic hash as well as the payload, so a validly signed
artifact for one task cannot be replayed under another task's key.

**Without `B4MAL_CACHE_SECRET` the remote cache is unauthenticated.** Entries are
stored with a null signature and accepted on the way back in, because there is no
key to check them against. Anything able to write to the bucket can then influence
workspace contents: path traversal is rejected (entries containing `..` or starting
with `/` cannot be extracted), but file *contents* are trusted — overwriting
`b4mal.config.json` or a `package.json` inside a restored artifact is enough to matter.

So: set a secret if the bucket is reachable by anyone you would not trust to edit
your working tree. Migrating to signed entries re-executes each already-cached task
once, since its stored artifact carries no signature.

The `logicHash` does not substitute for this. It *addresses* an artifact by its
inputs, so a mismatched hash means "not found", not "tampered with" — writing to the
bucket directly is the practical attack, not forging a colliding hash.

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
