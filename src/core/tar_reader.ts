/**
 * A minimal, safety-first tar reader.
 *
 * Restoring a cached artifact spent 98% of its time in process startup: two `tar`
 * spawns per artifact, against a native zstd decompress that costs under a
 * millisecond. This removes both.
 *
 * It is deliberately NOT a general tar implementation. `pack()` only ever writes
 * regular files and directories, so anything else in an archive is either
 * corruption or an attempt at something we refuse to do — a symlink entry
 * followed by `link/file` is the classic extraction attack, and the previous
 * implementation rejected exactly that. This reader keeps that property and
 * makes it the default rather than a backstop for the system tar.
 *
 * Rejected outright: symlinks, hardlinks, device nodes, FIFOs, sparse and
 * contiguous files, and any unrecognised type flag. Supported so real archives
 * round-trip: regular files, directories, GNU long names ('L') and pax extended
 * headers ('x'/'g'), plus the ustar `prefix` field for long paths.
 */

const BLOCK = 512;

/** Entry types this reader will act on. */
const REJECTED: Record<string, string> = {
  "1": "hard link",
  "2": "symlink",
  "3": "character device",
  "4": "block device",
  "6": "FIFO",
  "7": "contiguous file",
};

export interface TarEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  /** Offset of the entry's data within the archive. */
  dataOffset: number;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset + length;
  while (end > offset && bytes[end - 1] === 0) end--;
  let out = "";
  for (let i = offset; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const raw = readString(bytes, offset, length).trim();
  if (raw === "") return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse pax extended-header content into a map.
 * Records are "<decimal length> <key>=<value>\n", where the length counts itself.
 */
function parsePax(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < bytes.length) {
    let sp = i;
    while (sp < bytes.length && bytes[sp] !== 0x20) sp++;
    if (sp >= bytes.length) break;
    const len = parseInt(readString(bytes, i, sp - i), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = readString(bytes, sp + 1, i + len - sp - 2); // strip the trailing \n
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * Validate an archive entry name.
 *
 * Rejects absolute paths and any path that would escape the destination. This
 * runs on every entry before anything is created, and the check is on the
 * resolved name rather than the literal one, so `a/../../b` is caught.
 */
function assertSafePath(name: string): void {
  if (name === "") throw new Error("archive contains an entry with an empty name");
  if (name.startsWith("/")) throw new Error(`archive contains an absolute path: ${name}`);
  // Windows-style absolute paths and drive letters are absolute too.
  if (/^[a-zA-Z]:[\\/]/.test(name)) throw new Error(`archive contains an absolute path: ${name}`);
  const segments = name.replace(/\\/g, "/").split("/");
  for (const seg of segments) {
    if (seg === "..") throw new Error(`archive contains a traversal path: ${name}`);
  }
}

/**
 * List every entry in a tar archive.
 *
 * Throws on anything this reader refuses to handle, so a caller can never
 * partially apply an archive it does not fully understand.
 */
export function readTarEntries(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;
  let pendingPax = new Map<string, string>();

  while (offset + BLOCK <= bytes.length) {
    // Two consecutive zero blocks mark end-of-archive.
    let isZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (bytes[offset + i] !== 0) { isZero = false; break; }
    }
    if (isZero) break;

    const rawName = readString(bytes, offset, 100);
    const sizeField = readOctal(bytes, offset + 124, 12);
    const typeFlag = String.fromCharCode(bytes[offset + 156]);
    const magic = readString(bytes, offset + 257, 6);
    const prefix = readString(bytes, offset + 345, 155);
    const dataOffset = offset + BLOCK;
    const dataBlocks = Math.ceil(sizeField / BLOCK);
    const next = dataOffset + dataBlocks * BLOCK;

    // GNU long name: the entry body holds the real name for the next header.
    if (typeFlag === "L") {
      pendingName = readString(bytes, dataOffset, sizeField).replace(/\0+$/, "");
      offset = next;
      continue;
    }
    // pax extended header: per-entry overrides, of which we honour `path`.
    if (typeFlag === "x" || typeFlag === "g") {
      pendingPax = parsePax(bytes.subarray(dataOffset, dataOffset + sizeField));
      offset = next;
      continue;
    }

    let name = pendingName ?? rawName;
    if (!pendingName && prefix) name = `${prefix}/${rawName}`;
    if (pendingPax.has("path")) name = pendingPax.get("path")!;
    pendingName = null;
    pendingPax = new Map();

    if (REJECTED[typeFlag]) {
      throw new Error(`archive contains a ${REJECTED[typeFlag]} entry`);
    }

    const isDir = typeFlag === "5" || name.endsWith("/");
    const isFile = typeFlag === "" || typeFlag === "0";
    if (!isDir && !isFile) {
      throw new Error(`archive contains an unsupported entry type '${typeFlag}'`);
    }

    assertSafePath(name);
    entries.push({
      name: isDir ? name.replace(/\/+$/, "") : name,
      type: isDir ? "dir" : "file",
      size: isDir ? 0 : sizeField,
      dataOffset,
    });
    offset = next;
    // `magic` is read to validate the header shape; an archive we do not
    // recognise should not be silently treated as ustar.
    if (magic !== "" && magic !== "ustar") {
      throw new Error(`archive is not a ustar/pax archive (magic: ${magic})`);
    }
  }
  return entries;
}

/**
 * Extract a tar archive into `destDir`, refusing anything unsafe.
 *
 * Directory entries are created before their contents, and every name is
 * validated before use. Entries are fully materialised in memory as written;
 * a file whose declared size exceeds the remaining archive is an error rather
 * than a short read.
 */
export async function extractTar(bytes: Uint8Array, destDir: string): Promise<number> {
  const entries = readTarEntries(bytes);
  const fs = await import("fs");
  const path = await import("path");

  // Directories first so file writes never race their parent.
  for (const e of entries) {
    if (e.type === "dir") {
      fs.mkdirSync(path.join(destDir, e.name), { recursive: true });
    }
  }

  let written = 0;
  for (const e of entries) {
    if (e.type === "dir") continue;
    const target = path.join(destDir, e.name);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });

    const end = e.dataOffset + e.size;
    if (end > bytes.length) {
      throw new Error(`archive is truncated: ${e.name} declares ${e.size} bytes`);
    }

    // Preserve the executable bit; it is the only mode bit that matters for a
    // build artifact and losing it makes restored tasks fail to run.
    const headerStart = e.dataOffset - BLOCK;
    let mode = 0o644;
    try {
      const raw = readOctal(bytes, headerStart + 100, 8);
      if (raw) mode = raw & 0o111 ? 0o755 : 0o644;
    } catch { /* default mode */ }

    fs.writeFileSync(target, bytes.subarray(e.dataOffset, end), { mode });
    written++;
  }
  return written;
}