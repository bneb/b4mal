/**
 * Tests: the L1 cache must not depend on external binaries.
 *
 * `ArtifactVault.pack` used to shell out to `tar | zstd`. Windows runners ship
 * `tar` (bsdtar) but not `zstd`, so packing failed there and every build
 * re-executed — the cache silently did nothing on the platform where a silently
 * missing cache is worst. `unpack` already uses native zstd + an in-process tar
 * reader; this file drives `pack` to the same standard.
 *
 * The environment is simulated the way Windows actually looks: `zstd` present in
 * the filesystem (so it can even be invoked by absolute path) but NOT resolvable
 * from PATH. Each case runs `pack`/`unpack` in a child `bun` process with that
 * PATH, so the assertion is about what the shipped code does, not about how the
 * test was wired.
 *
 * These tests are expected to FAIL against the shell-out implementation and pass
 * once pack compresses in-process.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { ArtifactVault } from "../src/core/artifact_vault";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { existsSync } from "fs";

const testDirs: string[] = [];
afterAll(() => {
    for (const d of testDirs) fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * Run a snippet in a child bun process whose PATH excludes zstd.
 *
 * `zstd` is removed by pointing PATH at a directory that contains only `tar`
 * (and the other tools pack actually needs), reproducing the Windows runner where
 * `tar` resolves and `zstd` does not.
 */
async function runWithoutZstd(projectRoot: string, logicHash: string): Promise<{ code: number; out: string }> {
    // A minimal bin dir that has tar but not zstd.
    const bin = path.join(projectRoot, "__pathonly");
    await fs.mkdir(bin, { recursive: true });
    const tarPath = Bun.which("tar");
    if (tarPath) {
        try { await fs.symlink(tarPath, path.join(bin, "tar")); } catch { /* exists */ }
    }
    // On the child PATH: only our curated bin dir, bun's own directory (which
    // has bun but NOT zstd), and system basics. Nothing that would resolve zstd.
    const bunDir = path.dirname(process.execPath);
    const childPath = [bin, bunDir, "/usr/bin", "/bin"]
        .filter(p => existsSync(p))
        .join(path.delimiter);

    const script = `
        import { ArtifactVault } from ${JSON.stringify(path.join(import.meta.dir, "../src/core/artifact_vault"))};
        // With 'bun -e', process.argv[0]=bun, [1]=-e-ish, and the extra args we
        // append start at argv[2]. Read them by taking the last two entries to be
        // robust to how bun lays out argv for -e.
        const args = process.argv.slice(-2);
        const root = args[0], hash = args[1];
        try {
            await ArtifactVault.pack(hash, root, ["out/"]);
            console.log("PACK_OK");
        } catch (e) {
            console.log("PACK_FAIL:" + (e && e.message));
            process.exit(3);
        }
    `;

    const proc = Bun.spawn(["bun", "-e", script, projectRoot, logicHash], {
        env: { PATH: childPath, HOME: process.env.HOME ?? os.tmpdir() },
        stdout: "pipe", stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, out };
}

describe("L1 cache without external binaries", () => {
    test("pack succeeds when zstd is not on PATH (the Windows case)", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-nozstd-" + Date.now());
        await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });
        await fs.writeFile(path.join(projectRoot, "out", "a.txt"), "artifact content");
        testDirs.push(projectRoot);

        const logicHash = "deadbeef" + Date.now();
        const { code, out } = await runWithoutZstd(projectRoot, logicHash);

        // The whole point: packing must not require the zstd binary. A run that
        // says PACK_FAIL here is exactly the Windows regression.
        expect(out).toContain("PACK_OK");
        expect(code).toBe(0);
    });

    test("the produced artifact is a real zstd frame restorable by unpack", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-nozstd-rt-" + Date.now());
        await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });
        await fs.writeFile(path.join(projectRoot, "out", "a.txt"), "round trip");
        testDirs.push(projectRoot);

        const logicHash = "cafebabe" + Date.now();
        const { out } = await runWithoutZstd(projectRoot, logicHash);
        expect(out).toContain("PACK_OK");

        // unpack (in-process) must be able to read what pack (no-zstd) wrote.
        await fs.rm(path.join(projectRoot, "out"), { recursive: true, force: true });
        await ArtifactVault.unpack(logicHash, projectRoot);
        const restored = await fs.readFile(path.join(projectRoot, "out", "a.txt"), "utf-8");
        expect(restored).toBe("round trip");
    });
});