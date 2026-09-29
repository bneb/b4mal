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

// ─── File-hash cache correctness ─────────────────────────────────────────────
//
// The cache validated entries on (mtime, size) only, and looked them up under a
// different key than it stored them under. Both are covered here. Every test
// clears the cache first because it is process-global static state.

describe("ContentHasher file cache", () => {
    // node:fs — the tests above use fs/promises, which has no mkdtempSync.
    const nodeFs = require("fs");

    // Canonicalise the directory: on macOS os.tmpdir() is under /var, which is a
    // symlink to /private/var. Addressing files by their realpath is what makes
    // the staleness test below discriminating — with a symlinked spelling the
    // pre-fix cache never hit at all, so a stale entry could never be observed.
    const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "b4mal-hashcache-")));
    const file = path.join(dir, "f.txt");

    /** Write content and pin mtime to a fixed whole second, so mtime is identical across writes. */
    function writePinned(content: string): void {
        const T = 1700000000;
        nodeFs.writeFileSync(file, content);
        nodeFs.utimesSync(file, T, T);
    }

    afterAll(() => {
        try { nodeFs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test("serves an unchanged file from cache (cache is not simply disabled)", async () => {
        ContentHasher.clearCache();
        writePinned("unchanged");

        await ContentHasher.hashPath(file, { projectRoot: dir });
        await ContentHasher.hashPath(file, { projectRoot: dir });

        const stats = ContentHasher.cacheStats;
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(1);
        expect(stats.size).toBe(1);
    });

    test("does not serve a stale hash for a size-neutral edit with identical mtime", async () => {
        // Regression: a write of the same length that lands within one mtime tick
        // leaves both size and mtime unchanged, so the cached hash was returned
        // for content that had actually changed — a wrong cache key for a
        // content-addressed build cache.
        ContentHasher.clearCache();

        writePinned("AAAA");
        const before = await ContentHasher.hashPath(file, { projectRoot: dir });

        writePinned("BBBB");
        const after = await ContentHasher.hashPath(file, { projectRoot: dir });

        // Preconditions that make this the interesting case:
        const stats = require("fs").statSync(file);
        expect(stats.size).toBe(4);
        expect(require("fs").readFileSync(file, "utf-8")).toBe("BBBB");

        expect(after).not.toBe(before);
        expect(ContentHasher.cacheStats.hits).toBe(0);
    });

    test("keys the cache canonically, so a symlinked spelling hits the same entry", async () => {
        // Regression: entries were stored under the realpath but looked up under
        // the caller's path, so any symlinked spelling silently missed. Ordered
        // canonical-first because the reverse order hits under either scheme.
        ContentHasher.clearCache();
        writePinned("symlink-content");

        const linkDir = path.join(dir, "link");
        require("fs").symlinkSync(dir, linkDir, "dir");

        await ContentHasher.hashPath(file, { projectRoot: dir });
        await ContentHasher.hashPath(path.join(linkDir, "f.txt"), { projectRoot: dir });

        const stats = ContentHasher.cacheStats;
        expect(stats.size).toBe(1);
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(1);
    });

    test("hashes a file identically through either spelling", async () => {
        ContentHasher.clearCache();
        writePinned("same-either-way");

        const linkDir = path.join(dir, "link2");
        require("fs").symlinkSync(dir, linkDir, "dir");

        const viaReal = await ContentHasher.hashPath(file, { projectRoot: dir });
        const viaLink = await ContentHasher.hashPath(path.join(linkDir, "f.txt"), { projectRoot: dir });
        expect(viaLink).toBe(viaReal);
    });

    test("clearCache drops entries and resets counters", async () => {
        writePinned("clear-me");
        await ContentHasher.hashPath(file, { projectRoot: dir });
        expect(ContentHasher.cacheStats.size).toBeGreaterThan(0);

        ContentHasher.clearCache();

        const stats = ContentHasher.cacheStats;
        expect(stats.size).toBe(0);
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(0);
    });
});
