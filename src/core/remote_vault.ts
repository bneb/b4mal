/**
 * L2 remote cache orchestration: check → pull → promote, push with metadata.
 *
 * All S3 failures are non-fatal — builds proceed with L1-only on any error.
 * The RemoteVault is a thin orchestration layer between the executor and S3Adapter.
 */
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { S3Adapter } from "../remote/s3_adapter";
import { ArtifactVault } from "./artifact_vault";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CacheMetadata {
  logicHash: string;
  taskId: string;
  exitCode: number;
  durationMs: number;
  signature: string | null;
}

export interface CacheResult {
  hit: boolean;
  logicHash: string;
  durationMs?: number;
  exitCode?: number;
}

// ─── Metadata Embedding ────────────────────────────────────────────────────

/**
 * Prepend a length-prefixed JSON metadata header to raw bytes.
 * Format: [4-byte LE uint32 JSON length][UTF-8 JSON bytes][zstd stream]
 */
function embedMetadata(data: Buffer, metadata: CacheMetadata): Buffer {
  const jsonStr = JSON.stringify(metadata);
  const jsonBytes = Buffer.from(jsonStr, "utf-8");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32LE(jsonBytes.length, 0);
  return Buffer.concat([lengthBuf, jsonBytes, data]);
}

/**
 * Extract metadata from a length-prefixed archive.
 * Returns null if the header is corrupt or too small.
 */
function parseEmbeddedMetadata(data: Buffer): CacheMetadata | null {
  if (data.length < 5) return null;
  try {
    const jsonLen = data.readUInt32LE(0);
    if (jsonLen > data.length - 4 || jsonLen > 1024 * 1024) return null;
    const jsonBytes = data.subarray(4, 4 + jsonLen);
    return JSON.parse(jsonBytes.toString("utf-8"));
  } catch {
    return null;
  }
}

// ─── RemoteVault ───────────────────────────────────────────────────────────

export class RemoteVault {
  private adapter: S3Adapter | null;
  lastPromoted: string | null = null;

  constructor(adapter: S3Adapter | null) {
    this.adapter = adapter;
  }

  // ── checkAndPull ──────────────────────────────────────────────────────

  /**
   * Check L2 for a cached artifact. If found, download it and promote to L1.
   * Returns CacheResult on hit, null on miss or error.
   */
  async checkAndPull(
    logicHash: string,
    projectRoot: string,
  ): Promise<CacheResult | null> {
    if (!this.adapter) return null;

    try {
      const exists = await this.adapter.hasArtifact(logicHash);
      if (!exists) return null;
    } catch {
      return null;
    }

    // Download to a temp path, extract metadata, then promote to L1
    const tmpPath = join(projectRoot, ".b4mal", `l2-pull-${logicHash}.tmp`);
    try {
      const pulled = await this.adapter.pull(logicHash, tmpPath);
      if (!pulled) return null;

      // Read and parse the embedded metadata
      const rawData = await Bun.file(tmpPath).arrayBuffer();
      const metadata = parseEmbeddedMetadata(Buffer.from(rawData));

      if (!metadata) {
        // No valid metadata — treat as corrupt artifact, skip
        return null;
      }

      // Promote to L1: move the downloaded archive into the local vault
      this.promoteToL1(logicHash, tmpPath, projectRoot);
      this.lastPromoted = logicHash;

      return {
        hit: true,
        logicHash,
        durationMs: metadata.durationMs,
        exitCode: metadata.exitCode,
      };
    } catch {
      return null;
    }
  }

  // ── pushWithMetadata ──────────────────────────────────────────────────

  /**
   * Upload the local archive to L2 with embedded metadata.
   * Reads the L1 archive, prepends metadata header, uploads.
   * Non-fatal: returns false on failure, the build continues L1-only.
   */
  async pushWithMetadata(
    logicHash: string,
    projectRoot: string,
    metadata: CacheMetadata,
  ): Promise<boolean> {
    if (!this.adapter) return false;

    try {
      const l1Path = ArtifactVault.getArchivePath(logicHash, projectRoot);
      if (!existsSync(l1Path)) return false;

      const rawData = await Bun.file(l1Path).arrayBuffer();
      const archiveWithMeta = embedMetadata(Buffer.from(rawData), metadata);

      // Write to temp, upload, clean up
      const tmpPath = join(projectRoot, ".b4mal", `l2-push-${logicHash}.tmp`);
      writeFileSync(tmpPath, new Uint8Array(archiveWithMeta));

      const result = await this.adapter.push(logicHash, tmpPath);

      // Clean up temp file
      try { unlinkSync(tmpPath); } catch {}

      return result;
    } catch {
      return false;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private promoteToL1(
    logicHash: string,
    tmpPath: string,
    projectRoot: string,
  ): void {
    const vaultPath = ArtifactVault.getArchivePath(logicHash, projectRoot);
    const vaultDir = vaultPath.substring(0, vaultPath.lastIndexOf("/"));
    if (!existsSync(vaultDir)) {
      mkdirSync(vaultDir, { recursive: true });
    }
    // Strip the metadata header before storing in L1.
    // The S3 archive has [4-byte LE length][JSON][zstd stream].
    // L1 expects raw zstd, so we skip the header bytes.
    const rawData = Buffer.from(readFileSync(tmpPath));
    const headerLen = rawData.readUInt32LE(0);
    if (headerLen > 0 && headerLen < rawData.length - 4) {
      const zstdData = rawData.subarray(4 + headerLen);
      writeFileSync(vaultPath, zstdData);
    } else {
      // Fallback: copy as-is (shouldn't happen with valid archives)
      writeFileSync(vaultPath, rawData);
    }
  }
}

// Export for testing
export { embedMetadata, parseEmbeddedMetadata };
