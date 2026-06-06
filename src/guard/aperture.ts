// B4mal v3.0.0-alpha — The Core Aperture Engine
//
// Materializes a "Focal Point" for every task using atomic symlink
// projection. A task's visibility is limited strictly to its
// Z3-verified Resource Claims — nothing more, nothing less.
//
// The Aperture Lifecycle:
//   1. openAperture() — Projects a bespoke symlink environment
//   2. [task runs inside the aperture at maximum velocity]
//   3. closeAperture() — Dissolves the symlink tree (source untouched)

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApertureConfig {
    taskId: string;
    claims: string[];       // e.g. ["fs:src/compiler", "port:8080"]
    projectRoot: string;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class ApertureEngine {
    private counter = 0;

    /**
     * Project a "Focal View" for a task.
     *
     * Each fs: claim becomes a symlink from the aperture directory
     * back to the real source. Non-fs: claims (port:, env:) are
     * silently skipped — they are enforced at a different layer.
     *
     * Returns the aperture root path.
     */
    async openAperture(config: ApertureConfig): Promise<string> {
        const base = path.join(os.tmpdir(), "b4mal", "apertures");
        const uniqueId = `${config.taskId}-${Date.now()}-${this.counter++}`;
        const aperturePath = path.join(base, uniqueId);
        await fs.mkdir(aperturePath, { recursive: true });

        for (const claim of config.claims) {
            if (claim.startsWith("fs:")) {
                await this.projectFileSystem(claim, aperturePath, config.projectRoot);
            }
            // Non-fs claims (port:, env:, etc.) are silently skipped.
        }

        return aperturePath;
    }

    /**
     * Dissolve an aperture.
     *
     * CRITICAL: This removes the symlink tree WITHOUT following
     * the symlinks. The source code is never touched.
     */
    async closeAperture(aperturePath: string): Promise<void> {
        await this.safeRemoveTree(aperturePath);
    }

    // ── Private: Symlink Projection ──────────────────────────────────────

    private async projectFileSystem(
        claim: string,
        apertureBase: string,
        projectRoot: string,
    ): Promise<void> {
        const relativePath = claim.replace(/^fs:/, "").replace(/\/$/, "");
        
        // Prevent path traversal
        const normalized = path.normalize(relativePath);
        if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
            throw new Error(`Security Exception: Claim "${claim}" is invalid or attempts path traversal`);
        }

        const source = path.resolve(projectRoot, normalized);
        const target = path.join(apertureBase, normalized);

        // Ensure parent directories exist inside the aperture
        await fs.mkdir(path.dirname(target), { recursive: true });

        // Create the symlink pointing back to the real source
        await fs.symlink(source, target);
    }

    // ── Private: Safe Tree Removal (No Link Following) ───────────────────

    /**
     * Walk the aperture tree and remove:
     * - Symlinks → fs.unlink (does NOT follow the link)
     * - Directories → recurse then fs.rmdir
     * - Regular files → fs.unlink
     */
    private async safeRemoveTree(dirPath: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch {
            return; // Already gone
        }

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const stat = await fs.lstat(fullPath);

            if (stat.isSymbolicLink()) {
                await fs.unlink(fullPath);
            } else if (stat.isDirectory()) {
                await this.safeRemoveTree(fullPath);
            } else {
                await fs.unlink(fullPath);
            }
        }

        await fs.rmdir(dirPath);
    }
}
