/**
 * @file manifest.ts
 * @description Parses and validates package and workspace manifests (e.g., package.json, Cargo.toml).
 */

import { z } from "zod";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateLogicHash, generateLogicHashFromFile, isLogicHashable } from "./logic_hasher";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const ManifestSchema = z.object({
    /** SHA-256 Core Execution Identity */
    id: z.string(),
    version: z.string().default("0.5.0"),
    timestamp: z.number(),
    context: z.object({
        cwd: z.string(),
        /** Relative path → content hash */
        files: z.record(z.string(), z.string()),
        /** Relative path → logic hash (code files only) */
        logicFiles: z.record(z.string(), z.string()).default({}),
        /** Sanitized env subset */
        env: z.record(z.string()),
    }),
    /** Task IDs included in this manifest */
    tasks: z.array(z.string()),
});

export type Manifest = z.infer<typeof ManifestSchema>;

// ─── Builder ─────────────────────────────────────────────────────────────────

export class ManifestBuilder {
    private static IGNORE_LIST = new Set([
        ".git",
        "node_modules",
        "dist",
        ".b4mal",
        ".DS_Store",
    ]);

    /**
     * Generate a "No-Commit" manifest of the current local state.
     * Computes both content hashes and logic hashes concurrently.
     */
    static async build(
        taskIds: string[],
        targetEnv: string[] = [],
        cwd: string = process.cwd()
    ): Promise<Manifest> {
        const fileHashes: Record<string, string> = {};
        const logicHashes: Record<string, string> = {};
        const startNs = Bun.nanoseconds();

        // 1. Walk the local tree — dual hashing
        await this.scanDirectory(cwd, cwd, fileHashes, logicHashes);

        // 2. Capture specific environment variables (sanitized)
        const env: Record<string, string> = {};
        for (const key of targetEnv) {
            if (process.env[key]) env[key] = process.env[key]!;
        }

        // 3. Generate the Core Identity (includes logic hashes in identity)
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(JSON.stringify({ fileHashes, logicHashes, env, taskIds }));
        const id = hasher.digest("hex");

        const manifest = ManifestSchema.parse({
            id,
            timestamp: Date.now(),
            context: { cwd, files: fileHashes, logicFiles: logicHashes, env },
            tasks: taskIds,
        });

        const elapsedMs = (Bun.nanoseconds() - startNs) / 1e6;
        const fileCount = Object.keys(fileHashes).length;
        const logicCount = Object.keys(logicHashes).length;


        return manifest;
    }

    /**
     * Recursively scan a directory, computing both content and logic hashes concurrently.
     */
    private static async scanDirectory(
        dir: string,
        rootDir: string,
        contentHashes: Record<string, string>,
        logicHashes: Record<string, string>
    ): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });

        const promises: Promise<void>[] = [];

        for (const entry of entries) {
            if (this.IGNORE_LIST.has(entry.name)) continue;
            if (entry.name.startsWith(".")) continue;

            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                promises.push(this.scanDirectory(fullPath, rootDir, contentHashes, logicHashes));
            } else {
                promises.push(
                    (async () => {
                        const file = Bun.file(fullPath);
                        const buf = await file.arrayBuffer();
                        const relativePath = fullPath.replace(rootDir, ".");

                        // Content hash (always)
                        const contentHasher = new Bun.CryptoHasher("sha256");
                        contentHasher.update(buf);
                        contentHashes[relativePath] = contentHasher.digest("hex");

                        // Logic hash (code files only — concurrent)
                        if (isLogicHashable(relativePath)) {
                            logicHashes[relativePath] = await generateLogicHashFromFile(fullPath);
                        }
                    })()
                );
            }
        }

        await Promise.all(promises);
    }

    /**
     * Compare two manifests and return the set of changed file paths.
     * Uses logic hashes for code files to ignore non-functional changes.
     */
    static diff(prev: Manifest, curr: Manifest): { changed: string[]; logicallyUnchanged: string[] } {
        const changed: string[] = [];
        const logicallyUnchanged: string[] = [];
        const prevFiles = prev.context.files;
        const currFiles = curr.context.files;
        const prevLogic = prev.context.logicFiles ?? {};
        const currLogic = curr.context.logicFiles ?? {};

        // Changed or added files
        for (const [path, hash] of Object.entries(currFiles)) {
            if (prevFiles[path] !== hash) {
                // Content changed — but was the logic the same?
                if (prevLogic[path] && currLogic[path] && prevLogic[path] === currLogic[path]) {
                    logicallyUnchanged.push(path);
                } else {
                    changed.push(path);
                }
            }
        }

        // Deleted files
        for (const path of Object.keys(prevFiles)) {
            if (!(path in currFiles)) {
                changed.push(path);
            }
        }

        return { changed, logicallyUnchanged };
    }
}
