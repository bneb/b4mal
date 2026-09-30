/**
 * Tests: artifact extraction safety.
 *
 * The security property is narrow and absolute: extracting an artifact must never
 * create or modify anything outside the project root.
 *
 * Name validation alone cannot establish it. A tar entry can be a symlink, and
 * "escape -> /elsewhere" followed by "escape/file" passes any check that only
 * looks at names. The archives here are built byte by byte rather than with the
 * tar binary, because constructing this fixture on disk requires writing through
 * the symlink — which would create the very file the test is looking for, and made
 * a first attempt at this investigation report an exploit that did not exist.
 *
 * The assertion is the property, not the mechanism: no file may appear outside the
 * root, whichever tar implementation is installed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ArtifactVault } from "../src/core/artifact_vault";

let base: string;
let projectRoot: string;
let outside: string;

beforeEach(() => {
    base = join(tmpdir(), `b4mal-xtract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectRoot = join(base, "project");
    outside = join(base, "OUTSIDE");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
});

afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

// ─── A minimal tar writer ───────────────────────────────────────────────────

const BLOCK = 512;

function octal(value: number, length: number): string {
    // length includes the trailing NUL
    return value.toString(8).padStart(length - 1, "0") + "\0";
}

interface Entry {
    name: string;
    type?: "file" | "symlink" | "hardlink" | "dir";
    content?: string;
    linkname?: string;
}

/** Build a tar archive in memory. No filesystem access, no tar binary. */
function buildTar(entries: Entry[]): Buffer {
    const blocks: Buffer[] = [];

    for (const entry of entries) {
        const type = entry.type ?? "file";
        const typeflag = { file: "0", symlink: "2", hardlink: "1", dir: "5" }[type];
        const content = Buffer.from(entry.content ?? "", "utf-8");
        const size = type === "file" ? content.length : 0;

        const header = Buffer.alloc(BLOCK, 0);
        header.write(entry.name, 0, 100, "utf-8");
        header.write(octal(type === "dir" ? 0o755 : 0o644, 8), 100, 8, "utf-8");
        header.write(octal(0, 8), 108, 8, "utf-8");            // uid
        header.write(octal(0, 8), 116, 8, "utf-8");            // gid
        header.write(octal(size, 12), 124, 12, "utf-8");
        header.write(octal(0, 12), 136, 12, "utf-8");          // mtime
        header.write("        ", 148, 8, "utf-8");             // checksum placeholder
        header.write(typeflag, 156, 1, "utf-8");
        header.write(entry.linkname ?? "", 157, 100, "utf-8");
        header.write("ustar\0", 257, 6, "utf-8");
        header.write("00", 263, 2, "utf-8");

        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(octal(sum, 8), 148, 8, "utf-8");

        blocks.push(header);
        if (size > 0) {
            blocks.push(content);
            const padding = (BLOCK - (size % BLOCK)) % BLOCK;
            if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
        }
    }

    blocks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
    return Buffer.concat(blocks);
}

/** Store an in-memory tar in the vault as a compressed artifact. */
async function store(hash: string, tar: Buffer): Promise<void> {
    const archivePath = ArtifactVault.getArchivePath(hash, projectRoot);
    mkdirSync(join(archivePath, ".."), { recursive: true });

    const tarPath = join(base, "input.tar");
    await Bun.write(tarPath, tar);

    const proc = Bun.spawn(["zstd", "-f", "-q", "-o", archivePath, tarPath], { stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`zstd failed: ${await new Response(proc.stderr).text()}`);
}

/** Did anything land outside the project root? */
function escaped(): string[] {
    if (!existsSync(outside)) return [];
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const entry of require("fs").readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(full);
        }
    };
    walk(outside);
    return found;
}

// ─── The attacks ────────────────────────────────────────────────────────────

describe("ArtifactVault.unpack — extraction safety", () => {
    test("refuses an archive whose entry is a symlink pointing outside the root", async () => {
        const hash = "symlinkattack" + Date.now();
        const contentBefore = escaped();

        await store(hash, buildTar([
            { name: "escape", type: "symlink", linkname: outside },
            { name: "escape/written.txt", type: "file", content: "pwned\n" },
        ]));

        // Asserted as our own pre-emptive rejection, not merely /symlink/i: bsdtar
        // refuses this extraction itself with "Cannot extract through symlink", so
        // a loose match would pass even with the type check removed. Confirmed by
        // disabling the check — this assertion fails, and the property assertions
        // below still hold, which is exactly the distinction worth pinning.
        await expect(ArtifactVault.unpack(hash, projectRoot)).rejects.toThrow(/archive contains a symlink entry/i);

        // The property that actually matters, independent of how it is enforced:
        expect(escaped()).toEqual(contentBefore);
        expect(existsSync(join(outside, "written.txt"))).toBe(false);

        ArtifactVault.remove(hash, projectRoot);
    });

    test("refuses a hard link entry", async () => {
        const hash = "hardlinkattack" + Date.now();
        await store(hash, buildTar([
            { name: "real.txt", type: "file", content: "data\n" },
            { name: "link.txt", type: "hardlink", linkname: "real.txt" },
        ]));

        await expect(ArtifactVault.unpack(hash, projectRoot)).rejects.toThrow(/hard link/i);
        ArtifactVault.remove(hash, projectRoot);
    });

    test("refuses a traversal name even without any link entry", async () => {
        const hash = "traversal" + Date.now();
        await store(hash, buildTar([
            { name: "../escaped.txt", type: "file", content: "pwned\n" },
        ]));

        await expect(ArtifactVault.unpack(hash, projectRoot)).rejects.toThrow(/unsafe path|rejected|absolute path|traversal/i);
        expect(existsSync(join(base, "escaped.txt"))).toBe(false);
        ArtifactVault.remove(hash, projectRoot);
    });

    test("refuses an absolute path entry", async () => {
        const hash = "absolute" + Date.now();
        await store(hash, buildTar([
            { name: `${outside}/absolute.txt`, type: "file", content: "pwned\n" },
        ]));

        await expect(ArtifactVault.unpack(hash, projectRoot)).rejects.toThrow(/unsafe path|rejected|absolute path|traversal/i);
        expect(existsSync(join(outside, "absolute.txt"))).toBe(false);
        ArtifactVault.remove(hash, projectRoot);
    });

    test("still restores an ordinary archive", async () => {
        // The hardening must not reject legitimate artifacts, which contain only
        // regular files and directories.
        const hash = "legit" + Date.now();
        await store(hash, buildTar([
            { name: "out", type: "dir" },
            { name: "out/a.txt", type: "file", content: "hello\n" },
            { name: "out/nested", type: "dir" },
            { name: "out/nested/b.txt", type: "file", content: "world\n" },
        ]));

        await ArtifactVault.unpack(hash, projectRoot);

        expect(readFileSync(join(projectRoot, "out/a.txt"), "utf-8")).toBe("hello\n");
        expect(readFileSync(join(projectRoot, "out/nested/b.txt"), "utf-8")).toBe("world\n");
        expect(escaped()).toEqual([]);

        ArtifactVault.remove(hash, projectRoot);
    });
});
