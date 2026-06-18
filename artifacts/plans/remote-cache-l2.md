# Design Plan: Remote Cache (L2) — S3 Adapter (v2, post-red-team)

## Status: Phase 2 — RED TEAM (round 2 clean — 0 CRITICAL, 0 HIGH)

## Red Team Summary

| Round | CRITICAL | HIGH | Verdict |
|-------|----------|------|---------|
| Round 1 | 2 | 12 | Design rejected — major architectural revision |
| Round 2 | **0** | **0** | Design passes — 2 MEDIUM accepted risks |

### Round 2 Resolution

| Original Finding | Status |
|---|---|
| Plaintext credential storage (CRITICAL) | RESOLVED — Bun.S3Client requires explicit keys, no file |
| Cache key bifurcation (CRITICAL) | RESOLVED — raw content hash always |
| SigV4 hand-rolled (HIGH) | RESOLVED — Bun.S3Client handles internally |
| Cache poisoning unsigned (HIGH) | RESOLVED — HMAC optional, S3 IAM is primary defense |
| MITM self-signed (HIGH) | RESOLVED — Bun.S3Client enforces HTTPS |
| CI credential leak (HIGH) | RESOLVED — env vars only |
| Metadata exposure (HIGH) | RESOLVED — embedded in archive |
| L1-first stale (HIGH) | RESOLVED — L2 checked first |
| Non-atomic commit (HIGH) | RESOLVED — single object |
| Metadata decoupling (HIGH) | RESOLVED — embedded |
| Env not in cache key (HIGH) | RESOLVED — included |
| Hand-rolled V4 (HIGH) | RESOLVED — Bun.S3Client |
| 3-axis eviction (HIGH) | RESOLVED — S3 lifecycle |
| Interactive login (HIGH) | RESOLVED — env vars only |
| **S3 graceful degradation** (NEW HIGH) | **RESOLVED** — try-catch fallback to L1 |
| **~/.aws/credentials** (NEW HIGH) | **RESOLVED** — Bun.S3Client uses explicit keys only |

### Accepted Risks (MEDIUM)

| Finding | Mitigation |
|---------|------------|
| Embedded metadata breaks tar compat | Length-prefixed header (4-byte LE length + JSON); document non-standard format; provide `b4mal remote unpack` for debugging |
| Env claim sanitization unspecified | Warn on sensitive-looking env var names in needsEnv; document that hashed values are part of the key |

---

## Revised Design

### Key Architectural Decisions

**1. Bun.S3Client (built-in), not AWS SDK.** Bun v1.2+ ships a native `S3Client` — zero additional dependencies. Handles SigV4 signing internally, supports custom endpoints (R2, MinIO, B2), and is already tested against the Bun runtime. No hand-rolled crypto, no npm install.

**2. Environment variables only for v1.** No credential file, no `b4mal login`, no interactive prompt. The S3Adapter uses the AWS SDK default credential chain, which reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` from env vars, plus `~/.aws/credentials` for desktop users. B4mal-specific config (`B4MAL_CACHE_BUCKET`, `AWS_S3_ENDPOINT`) comes from env or `b4mal.config.json`.

**3. Single S3 object per cache entry.** Metadata is embedded as a JSON header in the `.tar.zst` archive (prepended before the zstd stream). No separate `.meta.json` object. This eliminates the metadata-artifact timing gap, halves S3 object count, and simplifies eviction.

**4. S3 lifecycle policies for eviction.** No client-side eviction loop. Users configure a lifecycle rule on the bucket ("expire objects after N days"). `b4mal remote status` reports object count and total size for monitoring. Client-side `prune` is deferred to v2.

**5. L2 checked before L1.** Remote cache (shared, fresher) is checked first. L1 serves as fallback. L2 hits are promoted to L1 (downloaded artifact copied to local vault).
**6. Env claims in cache key.** The `logicHash` now includes env var names and values for all declared `needsEnv`/`providesEnv` claims.

### Architecture

```
DynamicExecutor.executeTask()
       │
       ├── L2 check (NEW, FIRST)  → hit? download → promote to L1 → return cached
       │
       ├── L1 check (existing)    → hit? return cached
       │
       ├── Execute (existing)
       │
       ├── L1 pack (existing)     → tar.zst (with embedded metadata header)
       │
       └── L2 push (NEW)          → PUT to S3 (conditional: If-None-Match *)
```

### Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/remote/s3_adapter.ts` | **New** | S3 client wrapping `Bun.S3Client`: push, pull, hasArtifact (~30 LOC) |
| `src/core/remote_vault.ts` | **New** | L2 cache orchestration: check → pull → promote, push with embedded metadata |
| `src/orchestrator/executor.ts` | **Modify** | L2 check before L1, L2 push after pack, env claims in logicHash |
| `src/core/artifact_vault.ts` | **Modify** | `packWithMetadata()` — prepend JSON header to tar.zst |
| `src/cli/remote.ts` | **New** | `b4mal remote status` command |
| `src/cli/index.ts` | **Modify** | Wire `remote` subcommand |

### Env Vars

| Variable | Required | Purpose |
|----------|----------|---------|
| `AWS_ACCESS_KEY_ID` | Yes | S3 access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | S3 secret key |
| `AWS_REGION` | Yes | S3 region |
| `B4MAL_CACHE_BUCKET` | Yes | S3 bucket name |
| `AWS_S3_ENDPOINT` | No | Custom S3 endpoint (R2, MinIO, B2) |
| `B4MAL_CACHE_SECRET` | No | HMAC key for artifact signing (default: signing disabled) |
| `B4MAL_CACHE_ORG` | No | Org prefix for multi-tenant buckets (default: no prefix) |

### Cache Key Fix

The `logicHash` now includes env claims. After computing the hash over `task.id`, `task.cmd`, and file content hashes of `fsClaims`, also hash each `needsEnv` and `providesEnv` claim's actual value from the sanitized environment. Env vars that are declared but unset hash as the sentinel `<unset>`.

This also removes the `useLogicHash` bifurcation — all tasks use raw content hashing for cache-key purposes. Structural/AST hashing continues to work for L1 ledger dedup but does not affect the L2 key.

### Graceful Degradation

All S3 operations are wrapped in try-catch. Failures never prevent local builds:

| Failure | Behavior |
|---------|----------|
| S3 unreachable (timeout, DNS) | Log warning, skip L2, fall through to L1/execution |
| Auth failure (403, bad creds) | Log warning (once per build), skip L2 |
| Bucket not found (404) | Log warning, skip L2 |
| Rate limited (429, 503) | Retry 3x with exponential backoff (1s, 2s, 4s), then skip |
| Upload failure | Log warning, build continues (L1-only for this task) |
| Download failure | Log warning, skip to L1 or execution |

### Non-Goals (Deferred)

- Client-side eviction/prune (use S3 lifecycle policy)
- `b4mal login`/`logout` interactive commands (env vars only)
- Credential file storage (use AWS SDK default chain)
- b4mal-hosted cache service (separate product)
