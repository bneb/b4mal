/**
 * @file artifact_vault.ts
 * @description Manages L1 (local) archive packing and unpacking via strictly bounded POSIX file descriptors and zstd.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, unlinkSync } from "fs";

// ─── Vault ───────────────────────────────────────────────────────────────────

export class ArtifactVault {
    /** File extension for all archives. */
    static readonly archiveExtension = ".tar.zst";

    /** Resolve and ensure the vault directory exists. */
    private static getVaultDir(projectRoot?: string): string {
        if (!projectRoot) return join(homedir(), '.b4mal', "artifacts", "global");
        const crypto = require("crypto");
        const projHash = crypto.createHash("sha256").update(projectRoot).digest("hex");
        const dir = join(homedir(), '.b4mal', "artifacts", projHash);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    static getArchivePath(logicHash: string, projectRoot?: string): string {
        if (!/^[a-zA-Z0-9_.-]+$/.test(logicHash) || logicHash.includes("..")) {
            throw new Error(`Security Violation: Invalid logicHash format`);
        }
        return join(this.getVaultDir(projectRoot), `${logicHash}${this.archiveExtension}`);
    }

    /** Check if an artifact archive exists for a given hash. */
    static hasArtifact(logicHash: string, projectRoot?: string): boolean {
        return existsSync(this.getArchivePath(logicHash, projectRoot));
    }

    /**
     * Pack declared write paths into a zstd-compressed archive.
     *
     * Uses a shell pipe: tar -cf - ... | zstd -T0 > archive.tar.zst
     * This works on both macOS bsdtar and GNU tar, unlike -I 'zstd -T0'
     * which requires a single executable (bsdtar limitation).
     *
     * -T0 tells zstd to use all available CPU cores.
     */
    static async pack(
        logicHash: string,
        projectRoot: string,
        writes: string[],
    ): Promise<void> {
        if (writes.length === 0) return;

        const archivePath = this.getArchivePath(logicHash, projectRoot);
        const cleanPaths: string[] = [];
        const fs = require("fs");
        const path = require("path");
        const os = require("os");
        
        const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "b4mal-pack-"));
        try {
            for (const w of writes) {
                const p = w.replace(/^fs:/, "");
                if (p.startsWith("-") || path.isAbsolute(p) || p.includes("..")) {
                    throw new Error(`Security Violation: Invalid or malicious path detected: ${p}`);
                }
                
                if (projectRoot) {
                    try {
                        const src = path.resolve(projectRoot, p);
                        const dest = path.resolve(stageDir, p);
                        
                        const secureCopy = (s: string, d: string) => {
                            let fd: number;
                            try {
                                fd = fs.openSync(s, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                            } catch (e) {
                                return; // ignore missing or symlink rejection
                            }
                            
                            try {
                                const stats = fs.fstatSync(fd);
                                
                                // Enforce absolute strict bounds to prevent symlink breakouts.
                                const resolvedS = fs.realpathSync(s);
                                const resolvedRoot = fs.realpathSync(path.resolve(projectRoot));
                                if (!resolvedS.startsWith(resolvedRoot + path.sep) && resolvedS !== resolvedRoot) {
                                    throw new Error("Symlink breakout detected");
                                }
                                
                                // TOCTOU (Time-Of-Check to Time-Of-Use) mitigation.
                                // We verify the inode and device ID of the opened descriptor against the resolved path.
                                // If they differ, the path was swapped by a malicious concurrent process after O_NOFOLLOW.
                                const resolvedStats = fs.lstatSync(resolvedS);
                                if (stats.ino !== resolvedStats.ino || stats.dev !== resolvedStats.dev) {
                                    throw new Error("TOCTOU race detected");
                                }
                                
                                if (stats.isDirectory()) {
                                    fs.mkdirSync(d, { recursive: true });
                                    for (const child of fs.readdirSync(s)) {
                                        secureCopy(path.join(s, child), path.join(d, child));
                                    }
                                } else if (stats.isFile()) {
                                    fs.mkdirSync(path.dirname(d), { recursive: true });
                                    const destFd = fs.openSync(d, "w");
                                    try {
                                        const buffer = Buffer.alloc(65536);
                                        let bytesRead;
                                        let pos = 0;
                                        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, pos)) > 0) {
                                            fs.writeSync(destFd, buffer, 0, bytesRead);
                                            pos += bytesRead;
                                        }
                                    } finally {
                                        fs.closeSync(destFd);
                                    }
                                }
                            } finally {
                                fs.closeSync(fd);
                            }
                        };
                        secureCopy(src, dest);
                        cleanPaths.push(p);
                    } catch (e) {
                        console.error(e); continue;
                    }
                } else {
                    cleanPaths.push(p);
                }
            }
            
            if (cleanPaths.length === 0) return;

            const targetDir = projectRoot ? stageDir : ".";
            const tarArgs = ["tar", "-cf", "-", "-C", targetDir, "--", ...cleanPaths];
            const tarProc = Bun.spawn(tarArgs, {
                stdout: "pipe",
                stderr: "pipe",
            });

            const zstdProc = Bun.spawn(["zstd", "-T0", "-o", archivePath], {
                stdin: tarProc.stdout,
                stdout: "pipe",
                stderr: "pipe",
            });

            const [tarExit, zstdExit] = await Promise.all([tarProc.exited, zstdProc.exited]);

            if (tarExit !== 0 || zstdExit !== 0) {
                const tarErr = await new Response(tarProc.stderr).text();
                const zstdErr = await new Response(zstdProc.stderr).text();
                throw new Error(`Pack failed. tar: ${tarExit} (${tarErr.trim()}), zstd: ${zstdExit} (${zstdErr.trim()})`);
            }
        } finally {
            if (projectRoot) {
                fs.rmSync(stageDir, { recursive: true, force: true });
            }
        }
    }

    /**
     * Restore a zstd archive into the project root.
     *
     * Uses Bun's subprocess piping: zstd | tar
     */
    static async unpack(
        logicHash: string,
        projectRoot: string,
    ): Promise<void> {
        const archivePath = this.getArchivePath(logicHash, projectRoot);

        if (!existsSync(archivePath)) {
            throw new Error(`Artifact archive not found for hash: ${logicHash}`);
        }

        // List archive contents and verify no path traversal before extracting.
        // macOS bsdtar extracts ../ entries by default; GNU tar >= 1.29 blocks them,
        // but we verify explicitly for defense in depth across all platforms.
        const listProc = Bun.spawn(
            ["tar", "-tf", "-"],
            { stdin: Bun.spawn(["zstd", "-d", archivePath, "--stdout"]).stdout, stdout: "pipe", stderr: "pipe" },
        );
        const listOutput = await new Response(listProc.stdout).text();
        await listProc.exited;

        const resolvedRoot = require("fs").realpathSync(require("path").resolve(projectRoot));
        for (const entry of listOutput.trim().split("\n")) {
          if (!entry) continue;
          const normalized = entry.replace(/^\.\//, "");
          if (normalized.startsWith("/") || normalized.includes("..")) {
            throw new Error(`Unpack rejected: archive contains unsafe path "${entry}"`);
          }
        }

        // Extract to projectRoot — paths were pre-validated above
        const zstdProc = Bun.spawn(["zstd", "-d", archivePath, "--stdout"], { stdout: "pipe", stderr: "pipe" });
        const tarProc = Bun.spawn(["tar", "-xf", "-", "-C", projectRoot], {
            stdin: zstdProc.stdout, stdout: "pipe", stderr: "pipe",
        });

        const [zstdExit, tarExit] = await Promise.all([zstdProc.exited, tarProc.exited]);

        if (zstdExit !== 0 || tarExit !== 0) {
            const zstdErr = await new Response(zstdProc.stderr).text();
            const tarErr = await new Response(tarProc.stderr).text();
            throw new Error(`Unpack failed. zstd: ${zstdExit} (${zstdErr.trim()}), tar: ${tarExit} (${tarErr.trim()})`);
        }
    }

    /** Remove a cached artifact from the vault. */
    static remove(logicHash: string, projectRoot?: string): void {
        const archivePath = this.getArchivePath(logicHash, projectRoot);
        if (existsSync(archivePath)) {
            unlinkSync(archivePath);
        }
    }

    /**
     * Purge every .tar.zst archive from the project's vault directory.
     * Called by B4malEngine.clean().
     */
    static async purgeAll(projectRoot?: string): Promise<void> {
        const dir = this.getVaultDir(projectRoot);
        if (!existsSync(dir)) return;

        const { readdirSync } = await import("fs");
        const entries = readdirSync(dir);
        for (const entry of entries) {
            if (entry.endsWith(this.archiveExtension)) {
                unlinkSync(join(dir, entry));
            }
        }
    }
}
