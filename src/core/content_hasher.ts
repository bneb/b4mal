/**
 * @file content_hasher.ts
 * @description Computes SHA-256 hashes of filesystem trees to determine input determinism.
 */

import { createHash } from "crypto";
import { stat, readdir } from "fs/promises";
import { join } from "path";
import { createReadStream } from "fs";
import { generateLogicHash, generateLogicHashFromFile, isLogicHashable } from "./logic_hasher";

// Maximum number of file streams open simultaneously.
// Balances NVMe throughput vs. EMFILE risk.
const MAX_CONCURRENT_FILES = 64;

// SHA-256 of empty string — the ENOENT sentinel.
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ─── Semaphore ───────────────────────────────────────────────────────────────

export class Semaphore {
    private running = 0;
    private queue: (() => void)[] = [];

    constructor(private readonly max: number) {}

    acquire(): Promise<void> {
        if (this.running < this.max) {
            this.running++;
            return Promise.resolve();
        }
        return new Promise(resolve => this.queue.push(resolve));
    }

    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            this.running++;
            next();
        }
    }
}

// Module-level semaphore shared across the entire hashing call tree.
// This prevents cascading Promise.all() expansions from blowing file limits.
const fileSemaphore = new Semaphore(MAX_CONCURRENT_FILES);

export interface HashOptions {
    useLogicHash?: boolean;
    projectRoot?: string;
}

// ─── Hasher ──────────────────────────────────────────────────────────────────

export class ContentHasher {
    private static inflight = new Map<string, Promise<string>>();
    private static fileCache = new Map<string, { hash: string; mtime: number; size: number }>();

    /**
     * Recursively compute a deterministic SHA-256 hash of a file or directory.
     * Deduplicates concurrent requests for the same path.
     *
     * Files: SHA-256 of raw content (streamed).
     * Directories: sorted composite of (name + childHash) pairs — parallel.
     * Missing: SHA-256 of empty string (ENOENT sentinel).
     */
    static hashPath(targetPath: string, options: HashOptions = {}): Promise<string> {
        const cacheKey = options.useLogicHash ? `logic:${targetPath}` : targetPath;

        if (this.inflight.has(cacheKey)) {
            return this.inflight.get(cacheKey)!;
        }

        const promise = this._doHashPath(targetPath, options).finally(() => {
            this.inflight.delete(cacheKey);
        });

        this.inflight.set(cacheKey, promise);
        return promise;
    }

    private static async _doHashPath(targetPath: string, options: HashOptions): Promise<string> {
        let resolvedPath = targetPath;
        if (options.projectRoot) {
            const fs = require("fs");
            const path = require("path");
            resolvedPath = path.resolve(targetPath);
            try {
                resolvedPath = fs.realpathSync(resolvedPath);
            } catch (e) {
                // Ignore ENOENT on realpathSync for missing files, they are safely hashed as EMPTY_HASH
            }
            const resolvedRoot = fs.realpathSync(path.resolve(options.projectRoot));
            if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
                throw new Error(`Security Violation: Path traversal detected. Claim escapes project root: ${targetPath}`);
            }
        }
        
        try {
            const stats = await stat(resolvedPath);
            if (stats.isFile()) {
                // Check persistent file cache
                const cached = this.fileCache.get(targetPath);
                if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size && !options.useLogicHash) {
                    return cached.hash;
                }

                const hash = await this.hashFile(resolvedPath, options, stats.size);
                
                // Only cache raw content hashes, not logic hashes (logic hashes are more complex to cache safely)
                if (!options.useLogicHash) {
                    this.fileCache.set(resolvedPath, {
                        hash,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                    });
                }
                return hash;
            } else if (stats.isDirectory()) {
                return this.hashDirectory(resolvedPath, options);
            }
            return EMPTY_HASH;
        } catch (e: unknown) {
            if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return EMPTY_HASH;
            throw e;
        }
    }

    /**
     * Hash a directory: traverse children in parallel, sort results
     * alphabetically, then hash the sorted (name + childHash) pairs.
     *
     * Sorting happens AFTER parallel hashing to preserve determinism
     * regardless of filesystem traversal order.
     */
    private static async hashDirectory(dirPath: string, options: HashOptions): Promise<string> {
        const entries = await readdir(dirPath, { withFileTypes: true });

        // Kick off all child hashes in parallel
        const childResults = await Promise.all(
            entries.map(async (entry) => {
                const fullPath = join(dirPath, entry.name);
                const childHash = await this.hashPath(fullPath, options);
                return { name: entry.name, hash: childHash };
            })
        );

        // Sort alphabetically AFTER hashing (parallel, so order was non-deterministic)
        childResults.sort((a, b) => a.name.localeCompare(b.name));

        // Build composite hash from sorted (name, childHash) pairs
        const hash = createHash("sha256");
        hash.update("tree\0");
        for (const { name, hash: childHash } of childResults) {
            hash.update(name);
            hash.update("\0");
            hash.update(childHash);
            hash.update("\0");
        }
        return hash.digest("hex");
    }

    /**
     * Stream a file through SHA-256 guarded by the file semaphore.
     * Never loads the entire file into memory unless logic hashing is requested.
     */
    private static async hashFile(filePath: string, options: HashOptions, size?: number): Promise<string> {
        await fileSemaphore.acquire();
        try {
            if (options.useLogicHash && isLogicHashable(filePath) && (!size || size <= 10 * 1024 * 1024)) {
                const logicHash = await generateLogicHashFromFile(filePath);
                const hash = createHash("sha256");
                hash.update("blob\0");
                hash.update(logicHash);
                return hash.digest("hex");
            }

            return await new Promise<string>((resolve, reject) => {
                const hash = createHash("sha256");
                hash.update("blob\0");
                const stream = createReadStream(filePath);
                stream.on("data", (chunk) => hash.update(chunk));
                stream.on("end", () => {
                    resolve(hash.digest("hex"));
                });
                stream.on("error", (err) => {
                    reject(err);
                });
            });
        } finally {
            fileSemaphore.release();
        }
    }
}
