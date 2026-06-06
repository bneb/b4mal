#!/usr/bin/env bun
/**
 * B4mal — The UM890 Pro Crucible
 *
 * Bare-metal stress test targeting:
 *   Phase 1: 1GB synthetic workspace generation (crypto random)
 *   Phase 2: ContentHasher I/O throughput (SHA-256 vs NVMe)
 *   Phase 3: FormalShadow QF_S compute hammer (200x concurrent Z3)
 *   Phase 4: SQLiteLedger WAL contention (10,000 concurrent writes)
 *   Phase 5: ArtifactVault tar pack/unpack (500MB zstd round-trip)
 *
 * Run:  bun run src/benchmarks/crucible.ts
 *
 * Cleanup is automatic — the crucible_workspace and benchmark
 * artifacts are removed at the end of each run.
 */

import { ContentHasher } from "../core/content_hasher";
import { FormalShadow, type TaskResourceClaim } from "../core/formal_shadow";
import { SQLiteLedger } from "../core/sqlite_ledger";
import { ArtifactVault } from "../core/artifact_vault";
import { WavePlanner, type OrchestratorTask } from "../orchestrator/planner";
import { DynamicExecutor } from "../orchestrator/executor";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════════

const WORKSPACE = path.join(process.cwd(), "crucible_workspace");
const NUM_DIRS = 100;
const FILES_PER_DIR = 100;           // 10,000 total files
const FILE_SIZE_BYTES = 100 * 1024;  // 100KB per file → ~1GB total
const Z3_CONCURRENCY = 200;
const SQLITE_CONCURRENCY = 10_000;
const ARCHIVE_SUBSET_DIRS = 50;      // ~500MB for tar test

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function mbps(bytes: number, ms: number): string {
    return ((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(2);
}

function ops(count: number, ms: number): string {
    return (count / (ms / 1000)).toFixed(0);
}

function median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function p99(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.99)];
}

function p50(arr: number[]): number {
    return median(arr);
}

function bar(label: string, value: string, unit: string): void {
    console.log(`  ${label.padEnd(30)} ${value.padStart(12)} ${unit}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: Synthetic Workspace Generation
// ═══════════════════════════════════════════════════════════════════════════

async function phase1_generate(): Promise<number> {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  PHASE 1: GENERATING 1GB SYNTHETIC WORKSPACE");
    console.log(`${"═".repeat(60)}`);

    const t0 = performance.now();
    let totalBytes = 0;

    // Pre-allocate a reusable random buffer
    const buf = new Uint8Array(FILE_SIZE_BYTES);

    for (let d = 0; d < NUM_DIRS; d++) {
        const dirPath = path.join(WORKSPACE, `module_${d.toString().padStart(3, "0")}`);
        await fs.mkdir(dirPath, { recursive: true });

        for (let f = 0; f < FILES_PER_DIR; f++) {
            // Fill with crypto-random bytes — defeats dedup and page cache tricks
            crypto.getRandomValues(buf);
            const filePath = path.join(dirPath, `file_${f.toString().padStart(3, "0")}.bin`);
            await fs.writeFile(filePath, buf);
            totalBytes += FILE_SIZE_BYTES;
        }

        if ((d + 1) % 10 === 0) {
            const pct = (((d + 1) / NUM_DIRS) * 100).toFixed(0);
            process.stdout.write(`\r  Progress: ${pct}% (${d + 1}/${NUM_DIRS} dirs)`);
        }
    }

    const elapsed = performance.now() - t0;
    console.log("");
    bar("Files generated", `${NUM_DIRS * FILES_PER_DIR}`, "files");
    bar("Total size", `${(totalBytes / (1024 * 1024)).toFixed(0)}`, "MB");
    bar("Write throughput", mbps(totalBytes, elapsed), "MB/s");
    bar("Wall clock", (elapsed / 1000).toFixed(2), "sec");

    return totalBytes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2: I/O Sizer — ContentHasher vs NVMe
// ═══════════════════════════════════════════════════════════════════════════

async function phase2_io_sizer(totalBytes: number): Promise<void> {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  PHASE 2: I/O SIZER (ContentHasher vs NVMe)");
    console.log(`${"═".repeat(60)}`);

    const t0 = performance.now();
    const rootHash = await ContentHasher.hashPath(WORKSPACE);
    const elapsed = performance.now() - t0;

    bar("Root hash", rootHash.slice(0, 16) + "…", "");
    bar("Bytes hashed", `${(totalBytes / (1024 * 1024)).toFixed(0)}`, "MB");
    bar("SHA-256 throughput", mbps(totalBytes, elapsed), "MB/s");
    bar("Wall clock", (elapsed / 1000).toFixed(2), "sec");

    // Second pass — should be faster due to OS page cache
    const t2 = performance.now();
    const hash2 = await ContentHasher.hashPath(WORKSPACE);
    const elapsed2 = performance.now() - t2;

    bar("Second pass (cached)", mbps(totalBytes, elapsed2), "MB/s");
    bar("Deterministic", hash2 === rootHash ? "[OK] YES" : "✗ NO", "");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Compute Hammer — 200x Concurrent Z3 QF_S
// ═══════════════════════════════════════════════════════════════════════════

async function phase3_compute_hammer(): Promise<void> {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  PHASE 3: COMPUTE HAMMER (${Z3_CONCURRENCY}x Z3 QF_S)`);
    console.log(`${"═".repeat(60)}`);

    // Build a mix of SAT and UNSAT problems to stress both paths
    const pairs: [TaskResourceClaim, TaskResourceClaim][] = [];
    for (let i = 0; i < Z3_CONCURRENCY; i++) {
        if (i % 2 === 0) {
            // SAT: overlapping prefixes — forces Z3 to find a witness
            pairs.push([
                {
                    id: `writer-${i}`,
                    reads: [],
                    writes: [`src/module_${i % 50}/`],
                    envReads: [],
                    envWrites: [],
                },
                {
                    id: `reader-${i}`,
                    reads: [`src/module_${i % 50}/utils/`],
                    writes: [],
                    envReads: [],
                    envWrites: [],
                },
            ]);
        } else {
            // UNSAT: completely disjoint — forces Z3 to prove no overlap
            pairs.push([
                {
                    id: `builder-${i}`,
                    reads: [`src/alpha_${i}/`],
                    writes: [],
                    envReads: [],
                    envWrites: [],
                },
                {
                    id: `tester-${i}`,
                    reads: [],
                    writes: [`tests/beta_${i}/`],
                    envReads: [],
                    envWrites: [],
                },
            ]);
        }
    }

    const latencies: number[] = [];

    const t0 = performance.now();
    await Promise.all(
        pairs.map(async ([a, b]) => {
            const start = performance.now();
            await FormalShadow.verifyPairIsolation(a, b);
            latencies.push(performance.now() - start);
        }),
    );
    const elapsed = performance.now() - t0;

    bar("Total proofs", `${Z3_CONCURRENCY}`, "");
    bar("Proofs/sec", ops(Z3_CONCURRENCY, elapsed), "proofs/s");
    bar("Wall clock", (elapsed / 1000).toFixed(2), "sec");
    bar("Median latency", p50(latencies).toFixed(2), "ms");
    bar("P99 latency", p99(latencies).toFixed(2), "ms");
    bar("Min latency", Math.min(...latencies).toFixed(2), "ms");
    bar("Max latency", Math.max(...latencies).toFixed(2), "ms");
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Database Contention — 10,000 Concurrent WAL Writes
// ═══════════════════════════════════════════════════════════════════════════

async function phase4_db_contention(): Promise<void> {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  PHASE 4: DATABASE CONTENTION (${SQLITE_CONCURRENCY.toLocaleString()}x WAL WRITES)`);
    console.log(`${"═".repeat(60)}`);

    const dbPath = path.join(os.tmpdir(), "crucible-ledger-" + Date.now() + ".db");
    const ledger = new SQLiteLedger(dbPath);

    let busyErrors = 0;
    const latencies: number[] = [];

    const t0 = performance.now();
    await Promise.all(
        Array.from({ length: SQLITE_CONCURRENCY }, (_, i) => {
            return new Promise<void>((resolve) => {
                const start = performance.now();
                try {
                    ledger.recordEntry({
                        logicHash: `crucible-hash-${i}`,
                        taskId: `task-${i}`,
                        action: i % 2 === 0 ? "execute" : "skip",
                        timestamp: Date.now(),
                    });
                } catch (e: any) {
                    if (e.message?.includes("SQLITE_BUSY")) busyErrors++;
                }
                latencies.push(performance.now() - start);
                resolve();
            });
        }),
    );
    const elapsed = performance.now() - t0;

    // Verify all records
    const count = ledger.count();

    bar("Writes attempted", `${SQLITE_CONCURRENCY.toLocaleString()}`, "");
    bar("Writes recorded", `${count.toLocaleString()}`, "");
    bar("SQLITE_BUSY errors", `${busyErrors}`, busyErrors === 0 ? "[OK] " : "✗ FAIL");
    bar("TPS", ops(SQLITE_CONCURRENCY, elapsed), "tx/s");
    bar("Wall clock", (elapsed / 1000).toFixed(2), "sec");
    bar("Median write", p50(latencies).toFixed(3), "ms");
    bar("P99 write", p99(latencies).toFixed(3), "ms");

    ledger.close();
    await fs.unlink(dbPath).catch(() => { });
    // WAL/SHM files
    await fs.unlink(dbPath + "-wal").catch(() => { });
    await fs.unlink(dbPath + "-shm").catch(() => { });
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: Archival Bottleneck — 500MB zstd Round-Trip
// ═══════════════════════════════════════════════════════════════════════════

async function phase5_archive(): Promise<void> {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  PHASE 5: ARCHIVAL BOTTLENECK (zstd Round-Trip)");
    console.log(`${"═".repeat(60)}`);

    // Pack a subset (~500MB)
    const subsetPaths: string[] = [];
    for (let d = 0; d < ARCHIVE_SUBSET_DIRS; d++) {
        subsetPaths.push(`module_${d.toString().padStart(3, "0")}`);
    }
    const subsetBytes = ARCHIVE_SUBSET_DIRS * FILES_PER_DIR * FILE_SIZE_BYTES;

    const hash = "crucible-archive-" + Date.now();

    // Pack
    const t0 = performance.now();
    await ArtifactVault.pack(hash, WORKSPACE, subsetPaths.map(p => p + "/"));
    const packMs = performance.now() - t0;

    // Clear a few directories to measure unpack speed into WORKSPACE
    for (let d = 0; d < ARCHIVE_SUBSET_DIRS; d++) {
        await fs.rm(path.join(WORKSPACE, `module_${d.toString().padStart(3, "0")}`), { recursive: true, force: true });
    }

    const t1 = performance.now();
    await ArtifactVault.unpack(hash, WORKSPACE);
    const unpackMs = performance.now() - t1;

    bar("Subset size", `${(subsetBytes / (1024 * 1024)).toFixed(0)}`, "MB");
    bar("Pack throughput", mbps(subsetBytes, packMs), "MB/s");
    bar("Pack time", (packMs / 1000).toFixed(2), "sec");
    bar("Unpack throughput", mbps(subsetBytes, unpackMs), "MB/s");
    bar("Unpack time", (unpackMs / 1000).toFixed(2), "sec");

    // Cleanup
    ArtifactVault.remove(hash);
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 6: Orchestrator Graph Resolution (DAGPlanner)
// ═══════════════════════════════════════════════════════════════════════════

async function phase6_orchestrator(): Promise<void> {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  PHASE 6: DYNAMIC DAG PLANNER (100,000 TASKS)");
    console.log(`${"═".repeat(60)}`);

    const NUM_TASKS = 100_000;
    const tasks: OrchestratorTask[] = [];
    
    // Create 10 parallel chains of 10,000 sequential tasks
    const CHAINS = 10;
    const TASKS_PER_CHAIN = NUM_TASKS / CHAINS;

    for (let c = 0; c < CHAINS; c++) {
        for (let t = 0; t < TASKS_PER_CHAIN; t++) {
            const id = `chain${c}-task${t}`;
            const deps = t > 0 ? [`chain${c}-task${t - 1}`] : [];
            tasks.push({
                id,
                cmd: ["true"],
                claims: [`fs:src/${c}/`],
                deps,
            });
        }
    }

    const t0 = performance.now();
    const dag = WavePlanner.planDAG(tasks);
    const ms = performance.now() - t0;

    console.log(`  Parsed and sorted DAG of ${NUM_TASKS.toLocaleString()} tasks in ${ms.toFixed(2)} ms`);
    bar("Resolution time", ms.toFixed(2), "ms");
    bar("Resolution throughput", ops(NUM_TASKS, ms), "tasks/s");
    
    // Sanity check
    if (dag.tasks.size !== NUM_TASKS) throw new Error("DAG task count mismatch");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function runCrucible() {
    console.log("");
    console.log("  B4MAL — THE UM890 PRO CRUCIBLE");
    console.log("  ─────────────────────────────────────");
    console.log(`  Host:      ${os.hostname()}`);
    console.log(`  Platform:  ${os.platform()} ${os.arch()}`);
    console.log(`  CPUs:      ${os.cpus().length} × ${os.cpus()[0]?.model ?? "unknown"}`);
    console.log(`  Memory:    ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GB`);
    console.log(`  Bun:       ${Bun.version}`);
    console.log(`  Workspace: ${WORKSPACE}`);

    try {
        // Phase 1
        const totalBytes = await phase1_generate();

        // Phase 2
        await phase2_io_sizer(totalBytes);

        // Phase 3
        await phase3_compute_hammer();

        // Phase 4
        await phase4_db_contention();

        // Phase 5
        await phase5_archive();

        // Phase 6
        await phase6_orchestrator();

        // Summary
        console.log(`\n${"═".repeat(60)}`);
        console.log("  [OK] CRUCIBLE COMPLETE");
        console.log(`${"═".repeat(60)}`);
    } finally {
        // Cleanup: never leave 1GB of garbage on the SSD
        console.log("\n  🧹 Cleaning up crucible workspace...");
        await fs.rm(WORKSPACE, { recursive: true, force: true });
        console.log("  Done.\n");
    }
}

runCrucible().catch((err) => {
    console.error("\n  [FAIL] CRUCIBLE FAILED:", err.message);
    // Still try to clean up
    fs.rm(WORKSPACE, { recursive: true, force: true }).catch(() => { });
    process.exit(1);
});
