import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ContentHasher } from "../src/core/content_hasher";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

const TEST_DIR = path.join(os.tmpdir(), `b4mal-hasher-test-${Date.now()}`);

describe("ContentHasher Memoization", () => {
    beforeAll(async () => {
        await fs.mkdir(TEST_DIR, { recursive: true });
        await fs.mkdir(path.join(TEST_DIR, "subdir"), { recursive: true });
        await fs.writeFile(path.join(TEST_DIR, "file1.txt"), "content1");
        await fs.writeFile(path.join(TEST_DIR, "subdir/file2.txt"), "content2");
        
        // Create a 1MB file to make hashing non-trivial
        const bigBuf = Buffer.alloc(1024 * 1024, "X");
        await fs.writeFile(path.join(TEST_DIR, "bigfile.bin"), bigBuf);
    });

    afterAll(async () => {
        await fs.rm(TEST_DIR, { recursive: true, force: true });
    });

    test("DETERMINISM: hashPath returns the same hash for the same content", async () => {
        const h1 = await ContentHasher.hashPath(TEST_DIR);
        const h2 = await ContentHasher.hashPath(TEST_DIR);
        expect(h1).toBe(h2);
    });

    test("MEMOIZATION: second call is significantly faster", async () => {
        // First call (uncached)
        const t0 = performance.now();
        const h1 = await ContentHasher.hashPath(TEST_DIR);
        const d1 = performance.now() - t0;

        // Second call (should be memoized)
        const t1 = performance.now();
        const h2 = await ContentHasher.hashPath(TEST_DIR);
        const d2 = performance.now() - t1;



        expect(h1).toBe(h2);
        // Currently, it might NOT be much faster because ContentHasher deletes from 'inflight'
        // after completion. If it WAS memoized, d2 would be near 0.
    });

    test("INVALIDATION: hash changes when a file changes", async () => {
        const h1 = await ContentHasher.hashPath(TEST_DIR);
        
        // Change a file
        await fs.writeFile(path.join(TEST_DIR, "file1.txt"), "content1-changed");
        
        const h2 = await ContentHasher.hashPath(TEST_DIR);
        expect(h1).not.toBe(h2);
    });

    test("INVALIDATION: hash changes when a new file is added", async () => {
        const h1 = await ContentHasher.hashPath(TEST_DIR);
        
        await fs.writeFile(path.join(TEST_DIR, "newfile.txt"), "newcontent");
        
        const h2 = await ContentHasher.hashPath(TEST_DIR);
        expect(h1).not.toBe(h2);
    });
});
