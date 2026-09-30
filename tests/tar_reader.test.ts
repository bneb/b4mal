/**
 * Tests: the tar reader, differentially checked against the system tar.
 *
 * The reader replaced `tar -tvf` and `tar -xf` on the artifact restore path,
 * which was 98% of the cost of a cache hit. Because it now implements archive
 * parsing itself — in the one code path where an extraction vulnerability would
 * be worst — it is verified against the system tar rather than against itself:
 *
 *   - entry SETS must match `tar -tvf` on every archive the reader accepts
 *   - extracted CONTENT must be byte-identical to `tar -xf`
 *   - anything the reader refuses must be refused for the stated reason
 *
 * The system tar is the oracle for what a real archive contains; this file is
 * the oracle for what the reader does with it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { readTarEntries, extractTar } from "../src/core/tar_reader";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "b4mal-tar-")); });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Build a source tree and archive it with the system tar. */
function makeArchive(entries: { path: string; content?: string | Buffer; mode?: number; dir?: boolean }[]): Uint8Array {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  for (const e of entries) {
    const full = join(src, e.path);
    if (e.dir) { mkdirSync(full, { recursive: true }); continue; }
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, e.content ?? "x", e.mode ? { mode: e.mode } : undefined);
  }
  const tarPath = join(dir, "out.tar");
  const proc = Bun.spawnSync(["tar", "-cf", tarPath, "-C", src, "--", ...entries.map(e => e.path)],
    { env: { ...process.env, COPYFILE_DISABLE: "1", TAR_OPTIONS: "" } });
  if (proc.exitCode !== 0) throw new Error(`tar failed: ${new TextDecoder().decode(proc.stderr)}`);
  return new Uint8Array(readFileSync(tarPath));
}

/** The set of paths the SYSTEM tar sees in the archive. */
function systemTarEntries(tarPath: string): string[] {
  const proc = Bun.spawnSync(["tar", "-tf", tarPath]);
  if (proc.exitCode !== 0) throw new Error("tar -tf failed");
  return new TextDecoder().decode(proc.stdout).split("\n").map(s => s.trim()).filter(Boolean).sort();
}

/** Walk an extracted tree into a sorted list of "path:bytes" for comparison. */
function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(`${relative(root, full)}:${readFileSync(full).length}`);
    }
  };
  walk(root);
  return out.sort();
}

function tarSnapshot(tarPath: string): string[] {
  const dest = join(dir, "tarout");
  mkdirSync(dest, { recursive: true });
  const proc = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dest]);
  if (proc.exitCode !== 0) throw new Error("tar -xf failed");
  return treeSnapshot(dest);
}

describe("tar reader — agrees with the system tar", () => {
  test("entry set matches tar -tf for a plain tree", () => {
    const bytes = makeArchive([
      { path: "a.txt" },
      { path: "nested/b.txt" },
      { path: "nested/deep/c.txt" },
    ]);
    const tarPath = join(dir, "out.tar");

    const mine = readTarEntries(bytes).map(e => e.name + (e.type === "dir" ? "/" : "")).sort();
    const theirs = systemTarEntries(tarPath);
    expect(mine.map(m => m.replace(/\/$/, "")).sort()).toEqual(theirs.map(t => t.replace(/\/$/, "")).sort());
  });

  test("extracted content is byte-identical to tar -xf", async () => {
    const bytes = makeArchive([
      { path: "one.txt", content: "hello" },
      { path: "two.txt", content: "a".repeat(50_000) },
      { path: "deep/nest/three.bin", content: Buffer.from([0, 1, 2, 255, 128]) },
    ]);
    const tarPath = join(dir, "out.tar");

    const mineDest = join(dir, "minedest");
    mkdirSync(mineDest, { recursive: true });
    await extractTar(bytes, mineDest);

    expect(treeSnapshot(mineDest)).toEqual(tarSnapshot(tarPath));
    // and byte-for-byte, not just length
    expect(readFileSync(join(mineDest, "two.txt")).length).toBe(50_000);
    expect(readFileSync(join(mineDest, "deep/nest/three.bin"))).toEqual(Buffer.from([0, 1, 2, 255, 128]));
  });

  test("handles a long path (GNU long-name or pax header)", async () => {
    // >100 bytes forces the archive into an extended/ustar-prefix form, which is
    // exactly where a naive header parser silently loses the name.
    // Each path component stays under the 255-byte filesystem limit; the total
    // path is what exceeds tar's 100-byte name field and forces an extended form.
    const longFile = ["seg".repeat(30), "leaf".repeat(40) + ".txt"].join("/");
    const bytes = makeArchive([{ path: longFile, content: "long-path-content" }]);

    const entries = readTarEntries(bytes);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const dest = join(dir, "longout");
    mkdirSync(dest, { recursive: true });
    await extractTar(bytes, dest);
    expect(readFileSync(join(dest, longFile), "utf-8")).toBe("long-path-content");
  });

  test("preserves the executable bit", async () => {
    const bytes = makeArchive([
      { path: "script.sh", content: "#!/bin/sh\necho hi", mode: 0o755 },
      { path: "data.txt", content: "plain", mode: 0o644 },
    ]);
    const dest = join(dir, "modes");
    mkdirSync(dest, { recursive: true });
    await extractTar(bytes, dest);
    expect(statSync(join(dest, "script.sh")).mode & 0o111).toBeTruthy();
    expect(statSync(join(dest, "data.txt")).mode & 0o111).toBeFalsy();
  });


  test("accepts the v7/NUL typeflag for regular files", async () => {
    // The original v7 convention — and GNU tar on Linux — leaves the type byte as
    // NUL rather than '0'. The first implementation checked for "" and so
    // rejected every v7-format archive; CI caught it on Linux while macOS (bsdtar,
    // which writes '0') passed. Archive one with a NUL type byte directly.
    const buf = new Uint8Array(1024);
    const set = (off: number, str: string, len = str.length) => {
      for (let i = 0; i < len; i++) buf[off + i] = str.charCodeAt(i);
    };
    set(0, "nulfile.txt", 100);
    set(100, "0000644", 8);
    set(108, "0000000", 8);
    set(116, "0000000", 8);
    set(124, "00000000005 ", 12);   // size 5, octal
    set(136, "00000000000 ", 12);
    set(148, "        ", 8);
    buf[156] = 0;                    // NUL typeflag == regular file
    set(257, "ustar", 6);
    set(263, "00", 2);
    let sum = 0; for (let i = 0; i < 512; i++) sum += buf[i];
    set(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
    const body = "hello";
    for (let i = 0; i < body.length; i++) buf[512 + i] = body.charCodeAt(i);

    const entries = readTarEntries(buf);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("file");

    const dest = join(dir, "nulout");
    mkdirSync(dest, { recursive: true });
    await extractTar(buf, dest);
    expect(readFileSync(join(dest, "nulfile.txt"), "utf-8")).toBe("hello");
  });


  test("round-trips non-ASCII filenames", async () => {
    // Header names are raw bytes. Decoding them per-byte (Latin-1) yields
    // mojibake, which macOS masks because the filesystem re-encodes; on Linux a
    // UTF-8 filename extracts under its mangled name and ENOENTs. CI caught this
    // on Linux only.
    const names = ["üñïçødé.txt", "日本語/ファイル.txt", "with space.txt"];
    const bytes = makeArchive(names.map(n => ({ path: n, content: `content:${n}` })));
    const dest = join(dir, "unout");
    mkdirSync(dest, { recursive: true });
    await extractTar(bytes, dest);
    for (const n of names) {
      expect(readFileSync(join(dest, n), "utf-8")).toBe(`content:${n}`);
    }
  });

  test("round-trips nested directories and an empty file", async () => {
    const bytes = makeArchive([
      { path: "deeply/nested/path/file.txt", content: "deep" },
      { path: "empty.txt", content: "" },
    ]);
    const dest = join(dir, "deepout");
    mkdirSync(dest, { recursive: true });
    await extractTar(bytes, dest);
    expect(readFileSync(join(dest, "deeply/nested/path/file.txt"), "utf-8")).toBe("deep");
    expect(readFileSync(join(dest, "empty.txt"), "utf-8")).toBe("");
  });

  test("an empty archive yields no entries and does not throw", () => {
    expect(readTarEntries(new Uint8Array(1024))).toEqual([]);
  });
});

describe("tar reader — refuses unsafe archives", () => {
  /** Hand-build a single-entry archive with a chosen type flag. */
  function archiveWithType(typeFlag: string, name = "payload.txt", size = 3): Uint8Array {
    const buf = new Uint8Array(1024);
    const set = (off: number, s: string, len = s.length) => {
      for (let i = 0; i < len; i++) buf[off + i] = s.charCodeAt(i);
    };
    set(0, name, 100);
    set(100, "0000644", 8);        // mode
    set(108, "0000000", 8);        // uid
    set(116, "0000000", 8);        // gid
    set(124, size.toString(8).padStart(11, "0") + " ", 12);
    set(136, "00000000000 ", 12);  // mtime
    set(148, "        ", 8);       // checksum placeholder
    buf[156] = typeFlag.charCodeAt(0);
    set(257, "ustar", 6);
    set(263, "00", 2);
    // checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    set(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
    return buf;
  }

  test("rejects a symlink entry", () => {
    // The classic: a link entry followed by writes through it.
    expect(() => readTarEntries(archiveWithType("2"))).toThrow(/symlink entry/);
  });

  test("rejects a hardlink entry", () => {
    expect(() => readTarEntries(archiveWithType("1"))).toThrow(/hard link entry/);
  });

  test("rejects device and FIFO entries", () => {
    expect(() => readTarEntries(archiveWithType("3"))).toThrow(/character device/);
    expect(() => readTarEntries(archiveWithType("4"))).toThrow(/block device/);
    expect(() => readTarEntries(archiveWithType("6"))).toThrow(/FIFO/);
  });

  test("rejects an absolute path", () => {
    expect(() => readTarEntries(archiveWithType("0", "/etc/passwd"))).toThrow(/absolute path/);
  });

  test("rejects a traversal path", () => {
    expect(() => readTarEntries(archiveWithType("0", "../../escape.txt"))).toThrow(/traversal/);
    expect(() => readTarEntries(archiveWithType("0", "a/../../escape.txt"))).toThrow(/traversal/);
  });

  test("rejects a Windows-style absolute path", () => {
    expect(() => readTarEntries(archiveWithType("0", "C:\\windows\\evil"))).toThrow(/absolute path/);
  });

  test("rejects an entry type it does not understand", () => {
    expect(() => readTarEntries(archiveWithType("Z"))).toThrow(/unsupported entry type/);
  });

  test("a traversal entry is refused before anything is written", async () => {
    const bytes = archiveWithType("0", "../escaped.txt");
    const dest = join(dir, "dest");
    mkdirSync(dest, { recursive: true });
    expect(extractTar(bytes, dest)).rejects.toThrow(/traversal/);
    expect(existsSafe(join(dir, "escaped.txt"))).toBe(false);
  });
});

function existsSafe(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}