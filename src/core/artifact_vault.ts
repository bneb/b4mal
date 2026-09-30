/**
 * @file artifact_vault.ts
 * @description Manages L1 (local) archive packing and unpacking via strictly bounded POSIX file descriptors and zstd.
 */

import { join } from "path";
import { readTarEntries, extractTar } from "./tar_reader";
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

    /** Delete an artifact archive. No-op if it doesn't exist. */
    static remove(logicHash: string, projectRoot?: string): void {
        const archivePath = this.getArchivePath(logicHash, projectRoot);
        try { unlinkSync(archivePath); } catch { /* already gone */ }
    }

    /** Delete all artifact archives for a given project. */
    static async purgeAll(projectRoot: string): Promise<void> {
        const fs = require("fs");
        const vaultDir = this.getVaultDir(projectRoot);
        if (!existsSync(vaultDir)) return;
        try {
            for (const entry of fs.readdirSync(vaultDir)) {
                if (entry.endsWith(this.archiveExtension)) {
                    try { unlinkSync(join(vaultDir, entry)); } catch {}
                }
            }
        } catch { /* vault dir may not exist or be empty */ }
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

            // Write to a scratch path and rename into place only on success.
            //
            // Two reasons this is not written straight to `archivePath`:
            //  1. `zstd -o <existing>` refuses to overwrite when stdin is a pipe
            //     ("already exists; stdin is an input - not proceeding"), which
            //     made re-packing an existing hash impossible.
            //  2. A crash or failure mid-write would otherwise leave a truncated
            //     archive at the content-addressed path, which a later cache hit
            //     would happily "restore" as corrupt output.
            const scratchPath = `${archivePath}.pack-${process.pid}-${Date.now()}.tmp`;

            const zstdProc = Bun.spawn(["zstd", "-T0", "-f", "-o", scratchPath], {
                stdin: tarProc.stdout,
                stdout: "pipe",
                stderr: "pipe",
            });

            const [tarExit, zstdExit] = await Promise.all([tarProc.exited, zstdProc.exited]);

            if (tarExit !== 0 || zstdExit !== 0) {
                const tarErr = await new Response(tarProc.stderr).text();
                const zstdErr = await new Response(zstdProc.stderr).text();
                try { fs.rmSync(scratchPath, { force: true }); } catch { /* best effort */ }
                throw new Error(`Pack failed. tar: ${tarExit} (${tarErr.trim()}), zstd: ${zstdExit} (${zstdErr.trim()})`);
            }

            fs.renameSync(scratchPath, archivePath);
        } finally {
            if (projectRoot) {
                fs.rmSync(stageDir, { recursive: true, force: true });
            }
        }
    }

    /**
     * Restore a zstd archive into the project root.
     *
     * Decompresses to a temporary tarball first, then verifies and extracts it
     * with plain file-based `tar` invocations.
     *
     * This deliberately avoids piping `zstd --stdout` into `tar`. In that
     * arrangement tar stops reading as soon as it sees the end-of-archive
     * marker, closing the pipe while zstd is still writing; the resulting EPIPE
     * surfaces as an *unhandled* rejection (the inner child's stream is never
     * drained) and takes down the whole CLI process. Decompressing to a file
     * also means the archive is decompressed once instead of twice.
     */
    static async unpack(
        logicHash: string,
        projectRoot: string,
    ): Promise<void> {
        const archivePath = this.getArchivePath(logicHash, projectRoot);

        if (!existsSync(archivePath)) {
            throw new Error(`Artifact archive not found for hash: ${logicHash}`);
        }

        const fs = require("fs");
        const path = require("path");

        // Keep the scratch tarball beside the archive: if we could write the
        // archive there, we can write this there, so we never depend on an
        // ambient temp directory being writable.
        const tarPath = `${archivePath}.unpack-${process.pid}-${Date.now()}.tar`;

        try {
            // Decompress natively rather than shelling out to `zstd -d`.
            //
            // Process spawn is the dominant cost on a cache hit: ~40ms each on
            // this machine, and unpack spawns three (`zstd -d`, `tar -tvf`,
            // `tar -xf`), so restoring 16 artifacts spent ~1.9s almost entirely
            // in process startup. Removing the zstd spawn is the difference
            // between a cache hit costing three spawns per artifact and two.
            //
            // `tar` is deliberately still spawned: the entry-type validation
            // below must complete before anything is extracted, and re-implementing
            // tar header parsing in JS would put that security check on a much
            // riskier footing for a modest further saving.
            const { zstdDecompressSync } = require("bun") as typeof import("bun");
            const compressed = new Uint8Array(fs.readFileSync(archivePath));
            let tarBytes: Uint8Array;
            try {
                tarBytes = zstdDecompressSync(compressed);
            } catch (e: any) {
                throw new Error(`Unpack failed: zstd could not decompress the artifact (${e?.message ?? e})`);
            }
            fs.writeFileSync(tarPath, tarBytes);

            // Entries are validated on two axes before anything is extracted.
            //
            // Names alone are not enough to describe an archive. A tar entry can be
            // a symlink: "escape -> /somewhere" followed by "escape/file" is a
            // classic extraction attack, and both names here pass a name-only check.
            //
            // Measured: bsdtar (macOS) refuses this itself —
            //   "Cannot extract through symlink escape/written.txt"
            // — and exits non-zero, which the caller turns into a thrown error. So
            // this is not a hole being closed on that platform. The rejection is
            // explicit and happens *before* extraction rather than relying on the
            // tar implementation's own policy, which differs across platforms and
            // versions, and it produces a clear message instead of a tar error.
            //
            // pack() never produces link entries — secureCopy opens with
            // O_NOFOLLOW and skips anything that is not a regular file or directory
            // — so an archive containing one did not come from pack(), and rejecting
            // links cannot break a legitimate artifact.
            // Validate and extract in-process.
            //
            // This used to spawn three processes (`tar -tvf`, `tar -tf`,
            // `tar -xf`). Profiling showed 98% of a cache hit was process startup —
            // 33.6ms of tar against 0.7ms of native zstd decompress — so a build
            // restoring 16 artifacts spent over a second creating processes.
            //
            // The reader is verified differentially against the system tar in
            // tests/tar_reader.test.ts: same entry set, byte-identical
            // extraction, and the same refusal for links, absolute paths and
            // traversal. It is not a general tar implementation — pack() only
            // writes regular files and directories, and everything else is
            // refused, which is what the previous `-tvf` check did too.
            const entries = readTarEntries(new Uint8Array(fs.readFileSync(tarPath)));

            // Realpath resolves macOS /tmp → /private/tmp symlinks so boundary
            // checks compare canonical paths, not mixed symlink/resolved pairs.
            const resolvedRoot = fs.realpathSync(path.resolve(projectRoot));

            for (const entry of entries) {
                // Belt and braces: the reader already rejects these, but the
                // boundary is re-checked against the canonical root so the
                // guarantee does not rest on the parser alone.
                const resolved = path.resolve(resolvedRoot, entry.name);
                if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
                    throw new Error(`Unpack rejected: path "${entry.name}" escapes project root`);
                }
            }

            await extractTar(new Uint8Array(fs.readFileSync(tarPath)), projectRoot);
        } finally {
            try {
                fs.rmSync(tarPath, { force: true });
            } catch {
                // Best-effort cleanup; a leftover scratch tarball is harmless.
            }
        }
    }
}
