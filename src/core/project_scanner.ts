/**
 * @file project_scanner.ts
 * @description Recursively scans workspaces to construct the initial dependency matrix.
 */

import { readdir, readFile } from "fs/promises";
import { join, extname } from "path";

export interface SourceFile {
    path: string;
    content: string;
}

const EXCLUDE_DIRS = new Set([
    "node_modules",
    ".b4mal",
    "dist",
    "build",
    "coverage",
    ".git",
    ".next",
]);

export class ProjectScanner {
    /**
     * Recursively scan a directory for .ts source files.
     * Returns file path + content pairs for the forecaster.
     */
    static async scanSourceFiles(
        rootDir: string,
        maxFiles: number = 100
    ): Promise<SourceFile[]> {
        const results: SourceFile[] = [];
        await this.walkDir(rootDir, rootDir, results, maxFiles);
        return results;
    }

    private static async walkDir(
        dir: string,
        rootDir: string,
        results: SourceFile[],
        maxFiles: number
    ): Promise<void> {
        if (results.length >= maxFiles) return;

        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // Permission denied or missing dir
        }

        for (const entry of entries) {
            if (results.length >= maxFiles) break;

            if (entry.isDirectory()) {
                if (EXCLUDE_DIRS.has(entry.name)) continue;
                await this.walkDir(join(dir, entry.name), rootDir, results, maxFiles);
            } else if (entry.isFile() && extname(entry.name) === ".ts") {
                try {
                    const filePath = join(dir, entry.name);
                    const content = await readFile(filePath, "utf-8");
                    results.push({ path: filePath, content });
                } catch {
                    // Skip unreadable files
                }
            }
        }
    }
}
