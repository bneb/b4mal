// tests/soundness.test.ts — v4.0.0 Soundness Pivot (RED-to-GREEN)
//
// Content Hash Invalidation + QF_S Symbolic String Theory

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ContentHasher } from "../src/core/content_hasher";
import { FormalShadow, type TaskResourceClaim } from "../src/core/formal_shadow";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — Deterministic Content Hashing
// ═══════════════════════════════════════════════════════════════════════════

describe("ContentHasher — Invalidation", () => {
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = path.join(os.tmpdir(), "b4mal-hash-test-" + Date.now());
        await fs.mkdir(tmpDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test("modifying a file by 1 byte changes the hash", async () => {
        const filePath = path.join(tmpDir, "a.txt");

        await fs.writeFile(filePath, "hello world");
        const hash1 = await ContentHasher.hashPath(filePath);

        await Bun.sleep(2); // Wait to ensure mtimeMs ticks over

        await fs.writeFile(filePath, "hello worlD"); // 1 byte changed
        const hash2 = await ContentHasher.hashPath(filePath);

        expect(hash1).not.toBe(hash2);
        expect(hash1.length).toBe(64); // SHA-256 hex
        expect(hash2.length).toBe(64);
    });

    test("identical content produces identical hash", async () => {
        const f1 = path.join(tmpDir, "same1.txt");
        const f2 = path.join(tmpDir, "same2.txt");

        await fs.writeFile(f1, "exact content");
        await fs.writeFile(f2, "exact content");

        const hash1 = await ContentHasher.hashPath(f1);
        const hash2 = await ContentHasher.hashPath(f2);

        expect(hash1).toBe(hash2);
    });

    test("ENOENT returns the empty SHA-256 sentinel", async () => {
        const hash = await ContentHasher.hashPath("/nonexistent/path/xyz");

        // SHA-256 of empty string
        expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
});

describe("ContentHasher — Deterministic Directory Sort", () => {
    test("file creation order does not affect directory hash", async () => {
        // Round 1: create z.txt then a.txt
        const dir1 = path.join(os.tmpdir(), "b4mal-sort-test-1-" + Date.now());
        await fs.mkdir(dir1, { recursive: true });
        await fs.writeFile(path.join(dir1, "z.txt"), "content-z");
        await fs.writeFile(path.join(dir1, "a.txt"), "content-a");
        const hash1 = await ContentHasher.hashPath(dir1);

        // Round 2: create a.txt then z.txt (opposite order)
        const dir2 = path.join(os.tmpdir(), "b4mal-sort-test-2-" + Date.now());
        await fs.mkdir(dir2, { recursive: true });
        await fs.writeFile(path.join(dir2, "a.txt"), "content-a");
        await fs.writeFile(path.join(dir2, "z.txt"), "content-z");
        const hash2 = await ContentHasher.hashPath(dir2);

        expect(hash1).toBe(hash2);

        await fs.rm(dir1, { recursive: true, force: true });
        await fs.rm(dir2, { recursive: true, force: true });
    });

    test("nested directory hashing is recursive and deterministic", async () => {
        const root = path.join(os.tmpdir(), "b4mal-nested-test-" + Date.now());
        await fs.mkdir(path.join(root, "sub"), { recursive: true });
        await fs.writeFile(path.join(root, "top.txt"), "top");
        await fs.writeFile(path.join(root, "sub", "deep.txt"), "deep");

        const hash1 = await ContentHasher.hashPath(root);
        const hash2 = await ContentHasher.hashPath(root);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(64);

        await fs.rm(root, { recursive: true, force: true });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — QF_S String Theory
// ═══════════════════════════════════════════════════════════════════════════

describe("FormalShadow — QF_S Symbolic Overlap", () => {
    test("prefix overlap: fs:src/ vs fs:src/utils/ returns conflict", async () => {
        const taskA: TaskResourceClaim = {
            id: "compiler",
            reads: [],
            writes: ["src/"],       // directory claim (prefix)
            envReads: [],
            envWrites: [],
        };

        const taskB: TaskResourceClaim = {
            id: "linter",
            reads: ["src/utils/"],   // subdirectory claim (prefix)
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.isolated).toBe(false);
        expect(result.hasConflict).toBe(true);
        // The engine must provide a counterexample (the witnessing path)
        expect(result.counterexample).toBeDefined();
        expect(result.counterexample!.length).toBeGreaterThan(0);
    });

    test("disjoint paths: fs:src/ vs fs:tests/ returns provably safe", async () => {
        const taskA: TaskResourceClaim = {
            id: "builder",
            reads: ["src/"],
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const taskB: TaskResourceClaim = {
            id: "tester",
            reads: [],
            writes: ["tests/"],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.isolated).toBe(true);
        expect(result.hasConflict).toBe(false);
        expect(result.counterexample).toBeUndefined();
    });

    test("exact file in prefix: fs:src/ write vs fs:src/main.ts read returns conflict", async () => {
        const taskA: TaskResourceClaim = {
            id: "bundler",
            reads: [],
            writes: ["src/"],
            envReads: [],
            envWrites: [],
        };

        const taskB: TaskResourceClaim = {
            id: "checker",
            reads: ["src/main.ts"],
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.isolated).toBe(false);
        expect(result.hasConflict).toBe(true);
    });

    test("read-read on overlapping prefixes is NOT a conflict", async () => {
        const taskA: TaskResourceClaim = {
            id: "reader-a",
            reads: ["src/"],
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const taskB: TaskResourceClaim = {
            id: "reader-b",
            reads: ["src/utils/"],
            writes: [],
            envReads: [],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.isolated).toBe(true);
        expect(result.hasConflict).toBe(false);
    });

    test("env write vs env read produces conflict", async () => {
        const taskA: TaskResourceClaim = {
            id: "migrator",
            reads: [],
            writes: [],
            envReads: [],
            envWrites: ["DATABASE_URL"],
        };

        const taskB: TaskResourceClaim = {
            id: "seeder",
            reads: [],
            writes: [],
            envReads: ["DATABASE_URL"],
            envWrites: [],
        };

        const result = await FormalShadow.verifyPairIsolation(taskA, taskB);

        expect(result.isolated).toBe(false);
        expect(result.hasConflict).toBe(true);
    });

    test("verifier engine is 'PREFIX_TREE' and version is real", async () => {
        const version = await FormalShadow.getVerifierVersion();
        expect(version).toBe("1.0.0");
        expect(FormalShadow.getVerifierEngine()).toBe("PREFIX_TREE");
    });
});
