# Performance Benchmarks

Capacity numbers for the components that dominate a build's wall clock. These are
**measurements from one machine**, not comparisons against other tools — they tell
you what the machinery does here, and nothing more.

Run the suite yourself:

```bash
bun src/benchmarks/crucible.ts
```

## Measurement environment

| | |
|---|---|
| Host | Apple M4, 10 cores |
| Memory | 24.0 GB |
| OS | macOS (arm64) |
| Runtime | Bun 1.3.14 |
| Date | 2026-09-30 |
| Commit | `596b0da` |

**Read these as single-run figures.** Re-running moves them by a factor of two or
more on the I/O phases — repeated runs on this machine measured sequential write
between 266 and 389 MB/s and SHA-256 between 226 and 657 MB/s. Disk-backed
phases are noisy; the CPU-bound and graph phases are stable.

## Results

| Phase | Metric | Description | Measured |
|-------|--------|-------------|----------|
| 1. Workspace Gen | Sequential write | 977 MB of crypto-random data (defeats dedup and page cache) | `266.16 MB/s` |
| 2. ContentHasher | SHA-256, cold | Hashing the tree straight off disk | `656.74 MB/s` |
| 2. ContentHasher | SHA-256, cached | Same tree, resident in the OS page cache | `13443.31 MB/s` |
| 3. PrefixTree | Proofs/sec | 200 disjoint verifications, concurrent | `17,950 proofs/s` (median 1.83 ms, p99 7.45 ms) |
| 4. SQLite WAL | Ledger throughput | 10,000 concurrent ledger writes | `10,783 tx/s`, `0 SQLITE_BUSY` (median write 0.042 ms) |
| 5. Artifact Vault | zstd pack | 488 MB archive, multithreaded | `66.04 MB/s` |
| 5. Artifact Vault | zstd unpack | Decompression and restore | `56.03 MB/s` |
| 6. DAG Planner | Resolution | 100,000 tasks, 100 chains × 1,000 | `28,342 ms` (3,528 tasks/s), 99,900 edges |

The hash is deterministic — verified each run, not assumed.

## What the planner number does and does not tell you

Phase 6 is **shape-dependent**, and the shape matters more than the total.

The planner has two costs that scale differently:

- **Accepted-task overlap lookup** is indexed by a prefix tree. Graphs where
  packages own distinct outputs plan in near-linear time: 2,000 tasks in 36 ms,
  20,000 in 448 ms.
- **Wave colouring** (`splitByClaims`) is quadratic in the width of a wave —
  the number of tasks that could run concurrently. Phase 6 has 1,000 sequential
  waves of 100 parallel tasks, so it pays ~10<sup>7</sup> pair comparisons. A
  graph of the same 100,000 tasks arranged as narrower waves plans considerably
  faster.

So "100,000 tasks" is not a single number. It is a function of how parallel the
graph is.

## A cost that is inherent, not a defect

When *k* tasks write the **same** resource, they genuinely must be serialised, so
the injected dependency graph has O(k²) edges. 1,000 mutually-conflicting tasks
produce 499,500 edges. That is the isolation guarantee being correct rather than
the planner being slow, and it is the reason the previous version of this file's
planner figure was not a measurement of anything real — its benchmark gave every
task in a chain the same output claim, producing ~500 million edges and a graph
no scheduler can plan quickly.

`tests/planner_overlap_index.test.ts` asserts that edge count explicitly, so the
quadratic stays visible as a property of the guarantee instead of hiding as an
implementation detail.

## Corrections to earlier figures

An earlier revision of this file listed a 100,000-task planner time of ~146 ms.
That was not reproducible and should not have been published. It came from a
benchmark whose graph shape forced roughly 500 million serialisation edges, so no
planner could have produced that number on it. The table above is measured from
the current code on the machine described above.

*Vault packing uses Zstandard multithreading across available cores, so these
figures scale with core count.*