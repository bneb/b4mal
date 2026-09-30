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
import { ArtifactCrypto } from "./crypto";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CacheMetadata {
  logicHash: string;
  taskId: string;
  exitCode: number;
  durationMs: number;
  /**
   * HMAC-SHA256 over "<logicHash>:<sha256 of the payload>", or null when no
   * signing secret is configured. Set by pushWithMetadata, checked by
   * checkAndPull — see the note on signing below.
   */
  signature?: string | null;
}

export interface CacheResult {
  hit: boolean;
  logicHash: string;
  durationMs?: number;
  exitCode?: number;
}

// ─── Signing ───────────────────────────────────────────────────────────────

/**
 * Remote artifacts are only authenticated when a signing secret is configured.
 *
 * Set `B4MAL_CACHE_SECRET` and pushes are signed, pulls are verified, and an
 * artifact that fails verification is treated as a miss (so the task simply
 * re-executes). Without it the remote cache is unauthenticated — anything that
 * can write to the bucket can influence workspace contents — which is why that
 * is stated plainly in docs/concepts/caching.md rather than implied away.
 *
 * The signed input covers three things: the logic hash, the payload, and the
 * metadata. Binding the logic hash stops a validly signed artifact for one task
 * being served under another task's key. Binding the metadata stops the exit code
 * and duration being edited after signing — those are read back on a pull and
 * reported as the task's result, so leaving them outside the signature would have
 * made the header a place to write unauthenticated data.
 */
function sha256Hex(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/**
 * Deterministic serialization of the metadata, excluding the signature itself
 * (which cannot cover its own value). Keys are sorted so writer and reader agree
 * regardless of JSON property order.
 */
function stableMetadataJson(metadata: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = metadata;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function signedInput(logicHash: string, payload: Buffer, metadata: Record<string, unknown>): string {
  return `${logicHash}:${sha256Hex(payload)}:${sha256Hex(stableMetadataJson(metadata))}`;
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

export interface L2Stats {
  pushes: number;
  pulls: number;
  hits: number;
  bytesUp: number;
  bytesDown: number;
}

export class RemoteVault {
  private adapter: S3Adapter | null;
  private crypto: ArtifactCrypto;
  lastPromoted: string | null = null;
  /** Artifacts rejected because their signature was missing or wrong. */
  rejected: number = 0;
  stats: L2Stats = { pushes: 0, pulls: 0, hits: 0, bytesUp: 0, bytesDown: 0 };

  constructor(adapter: S3Adapter | null, crypto: ArtifactCrypto = new ArtifactCrypto()) {
    this.adapter = adapter;
    this.crypto = crypto;
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
      const payload = Buffer.from(rawData);
      const metadata = parseEmbeddedMetadata(payload);

      if (!metadata) {
        // No valid metadata — treat as corrupt artifact, skip
        return null;
      }

      // Verify the signature before anything touches the workspace. When a
      // secret is configured an unsigned or wrongly signed artifact is a miss,
      // so the task re-executes instead of restoring attacker-controlled files.
      const headerLen = payload.readUInt32LE(0);
      const archiveBytes = payload.subarray(4 + headerLen);
      const signatureValid = this.crypto.verify(
        signedInput(logicHash, archiveBytes, metadata as unknown as Record<string, unknown>),
        metadata.signature ?? undefined,
      );
      if (!signatureValid) {
        this.rejected++;
        process.stderr.write(
          `\x1b[2m[L2] rejected artifact for ${logicHash.slice(0, 12)}…: ` +
          `signature missing or invalid — re-executing\x1b[0m\n`,
        );
        return null;
      }

      // Promote to L1: move the downloaded archive into the local vault
      this.promoteToL1(logicHash, tmpPath, projectRoot);
      this.lastPromoted = logicHash;
      this.stats.hits++;
      this.stats.pulls++;
      try { this.stats.bytesDown += Bun.file(tmpPath).size; } catch {}

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

      const rawData = Buffer.from(await Bun.file(l1Path).arrayBuffer());

      // Sign the payload and the metadata together when a secret is configured;
      // otherwise record null and pulls run in trust mode.
      const metaBase = { ...metadata, logicHash };
      const signature = this.crypto.sign(signedInput(logicHash, rawData, metaBase));

      const archiveWithMeta = embedMetadata(rawData, { ...metaBase, signature });

      // Write to temp, upload, clean up
      const tmpPath = join(projectRoot, ".b4mal", `l2-push-${logicHash}.tmp`);
      writeFileSync(tmpPath, new Uint8Array(archiveWithMeta));

      const result = await this.adapter.push(logicHash, tmpPath);
      if (result) {
        this.stats.pushes++;
        try { this.stats.bytesUp += Bun.file(tmpPath).size; } catch {}
      }

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
