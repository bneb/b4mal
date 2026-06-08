// tests/performance.test.ts — v4.4.0 Performance Optimizations (RED-to-GREEN)

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";
import { ArtifactVault } from "../src/core/artifact_vault";
import { ContentHasher } from "../src/core/content_hasher";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — Prefix Tree Prover
// ═══════════════════════════════════════════════════════════════════════════

describe("FormalShadow — Integrity", () => {
    test("FormalShadow processes claims correctly", async () => {
        const taskA: TaskResourceClaim = {
            id: "a",
            reads: [],
            writes: ["src/lib/"],
            envReads: [],
            envWrites: [],
        };
        const taskB: TaskResourceClaim = {
            id: "b",
            reads: ["src/lib/index.ts"],
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.hasConflict).toBe(true);
        expect(result.isolated).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — Zstd Archival
// ═══════════════════════════════════════════════════════════════════════════

describe("ArtifactVault — Zstd", () => {
    test("archive ends in .tar.zst (not .tar.gz)", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-zstd-test-" + Date.now());
        await fs.mkdir(path.join(projectRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(projectRoot, "dist", "app.js"), "console.log('hi')");

        const hash = "zstd-ext-test-" + Date.now();

        await ArtifactVault.pack(hash, projectRoot, ["dist/"]);

        expect(ArtifactVault.archiveExtension).toBe(".tar.zst");
        expect(ArtifactVault.hasArtifact(hash, projectRoot)).toBe(true);

        // Check the actual file on disk
        const archivePath = ArtifactVault.getArchivePath(hash, projectRoot);
        expect(archivePath.endsWith(".tar.zst")).toBe(true);

        ArtifactVault.remove(hash, projectRoot);
        await fs.rm(projectRoot, { recursive: true, force: true });
    });

    test("zstd pack then unpack restores exact content", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-zstd-rt-" + Date.now());
        await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });

        const content = "zstd round-trip data — " + Math.random();
        await fs.writeFile(path.join(projectRoot, "out", "data.bin"), content);

        const hash = "zstd-rt-" + Date.now();

        await ArtifactVault.pack(hash, projectRoot, ["out/"]);
        await fs.rm(path.join(projectRoot, "out"), { recursive: true, force: true });
        await ArtifactVault.unpack(hash, projectRoot);

        const restored = await fs.readFile(path.join(projectRoot, "out", "data.bin"), "utf-8");
        expect(restored).toBe(content);

        ArtifactVault.remove(hash, projectRoot);
        await fs.rm(projectRoot, { recursive: true, force: true });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// § 3 — Concurrent Hashing Determinism
// ═══════════════════════════════════════════════════════════════════════════

describe("ContentHasher — Concurrent Determinism", () => {
    test("1000-file directory produces same hash regardless of creation order", async () => {
        const FILE_COUNT = 1000;

        // Round 1: create files 0..999
        const dir1 = path.join(os.tmpdir(), "b4mal-concurrent-hash-1-" + Date.now());
        await fs.mkdir(dir1, { recursive: true });
        for (let i = 0; i < FILE_COUNT; i++) {
            await fs.writeFile(path.join(dir1, `file_${i.toString().padStart(4, "0")}.txt`), `content-${i}`);
        }
        const hash1 = await ContentHasher.hashPath(dir1);

        // Round 2: create files in reverse order (999..0)
        const dir2 = path.join(os.tmpdir(), "b4mal-concurrent-hash-2-" + Date.now());
        await fs.mkdir(dir2, { recursive: true });
        for (let i = FILE_COUNT - 1; i >= 0; i--) {
            await fs.writeFile(path.join(dir2, `file_${i.toString().padStart(4, "0")}.txt`), `content-${i}`);
        }
        const hash2 = await ContentHasher.hashPath(dir2);

        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64);

        await fs.rm(dir1, { recursive: true, force: true });
        await fs.rm(dir2, { recursive: true, force: true });
    }, 30000); // 30s — 2000 file writes + 2 hash passes

    test("1-byte content change invalidates concurrent hash", async () => {
        const dir = path.join(os.tmpdir(), "b4mal-concurrent-invalidate-" + Date.now());
        await fs.mkdir(dir, { recursive: true });

        for (let i = 0; i < 100; i++) {
            await fs.writeFile(path.join(dir, `file_${i}.txt`), `content-${i}`);
        }

        const hash1 = await ContentHasher.hashPath(dir);

        // Change one byte in one file
        await fs.writeFile(path.join(dir, "file_0.txt"), "content-0-CHANGED");

        const hash2 = await ContentHasher.hashPath(dir);

        expect(hash1).not.toBe(hash2);

        await fs.rm(dir, { recursive: true, force: true });
    }, 15000);

    test("does not hit EMFILE with 500 files in a flat directory", async () => {
        const dir = path.join(os.tmpdir(), "b4mal-emfile-test-" + Date.now());
        await fs.mkdir(dir, { recursive: true });

        // Create 500 files simultaneously — the semaphore should gate file opens
        await Promise.all(
            Array.from({ length: 500 }, (_, i) =>
                fs.writeFile(path.join(dir, `file_${i}.bin`), Buffer.alloc(1024, i))
            )
        );

        // Should not throw EMFILE
        await expect(ContentHasher.hashPath(dir)).resolves.toHaveLength(64);

        await fs.rm(dir, { recursive: true, force: true });
    }, 20000);
});
