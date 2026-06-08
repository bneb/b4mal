# Performance Benchmarks

B4mal is designed to eliminate build orchestration taxes. We continuously monitor and regress performance using the **Crucible**, a 5-phase bare-metal stress test targeting NVMe throughput, I/O bottlenecks, and SQLite WAL contention.

### Execution Environment
The following benchmarks were conducted on an Apple Silicon machine using the `src/benchmarks/crucible.ts` suite.

**Hardware Details:**
- **Host:** Apple M4 (10 Cores)
- **Memory:** 24.0 GB
- **OS:** macOS Darwin (arm64)
- **Runtime:** Bun 1.3.10

### Results

| Phase | Metric | Description | Result |
|-------|--------|-------------|--------|
| **1. Workspace Gen** | NVMe Write Throughput | 1GB crypto-random synthesis. | `938.56 MB/s` |
| **2. ContentHasher** | I/O Sizer (Cold) | SHA-256 tree computation against cold NVMe. | `1812.65 MB/s` |
| **2. ContentHasher** | I/O Sizer (Cached) | SHA-256 tree computation against OS Page Cache. | `44935.32 MB/s` |
| **3. Solver Compute** | PrefixTree Proofs | Concurrent disjoint verification using prefix tree traversal. | `86,116 proofs/s` |
| **4. SQLite WAL** | Database Contention | 10,000 concurrent ledger writes. | `7,931 TPS` (0 `SQLITE_BUSY`) |
| **5. Artifact Vault** | zstd Pack Throughput | Tarball archive generation using `-T0` multithreading. | `125.63 MB/s` |
| **5. Artifact Vault** | zstd Unpack Throughput | Decompression and workspace restoration. | `164.92 MB/s` |
| **6. DAG Planner** | Synthetic Resolution | Topological sorting and concurrency validation of 100,000 tasks. | `~146 ms` |

*Note: Vault packing uses Zstandard compression dynamically leveraging all available CPU cores. Performance will scale vertically on higher core-count machines.*
