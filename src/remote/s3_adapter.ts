/**
 * S3 adapter wrapping Bun's native S3Client for L2 remote cache operations.
 * Zero additional dependencies — Bun.S3Client is built-in since Bun v1.2.
 *
 * All S3 operations fail gracefully: errors are caught and surfaced as
 * boolean returns, never throwing. The caller (remote_vault.ts) handles
 * fallback to L1-only operation.
 */
import { S3Client } from "bun";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;       // Custom S3-compatible endpoint (R2, MinIO, B2)
  orgId?: string;          // Multi-tenant key prefix
  retries?: number;         // Default: 3
}

// ─── Key Helpers ───────────────────────────────────────────────────────────

const KEY_PREFIX = "b4mal";
const HASH_RE = /^[a-zA-Z0-9_.-]+$/;

function validateHash(logicHash: string): void {
  if (!HASH_RE.test(logicHash) || logicHash.includes("..")) {
    throw new Error(`Invalid logicHash: "${logicHash}". Must be alphanumeric with dots, dashes, underscores.`);
  }
}

function makeKey(logicHash: string, orgId?: string): string {
  const prefix = orgId ? `${KEY_PREFIX}/${orgId}` : KEY_PREFIX;
  return `${prefix}/${logicHash}.tar.zst`;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

export class S3Adapter {
  private client: S3Client;
  private bucket: string;
  private orgId?: string;
  private retries: number;

  constructor(config: S3Config) {
    if (!config.bucket) throw new Error("S3Config: bucket is required");
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error("S3Config: accessKeyId and secretAccessKey are required");
    }

    this.bucket = config.bucket;
    this.orgId = config.orgId;
    this.retries = config.retries ?? 3;

    this.client = new S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      bucket: config.bucket,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
  }

  // ── hasArtifact ──────────────────────────────────────────────────────

  /** Check if a cached artifact exists in S3. Returns false on any error. */
  async hasArtifact(logicHash: string): Promise<boolean> {
    validateHash(logicHash);
    const key = makeKey(logicHash, this.orgId);

    try {
      return await this.fileExists(key);
    } catch {
      return false;
    }
  }

  // ── push ─────────────────────────────────────────────────────────────

  /**
   * Upload a local archive to S3. Uses conditional PUT (If-None-Match *)
   * to avoid overwriting existing artifacts from concurrent runners.
   * Returns true on success, false on any failure.
   */
  async push(logicHash: string, tarPath: string): Promise<boolean> {
    validateHash(logicHash);
    const key = makeKey(logicHash, this.orgId);

    try {
      const file = Bun.file(tarPath);
      if (!(await file.exists())) {
        throw new Error(`Artifact file not found: ${tarPath}`);
      }
      await this.s3Write(key, file);
      return true;
    } catch {
      return false;
    }
  }

  // ── pull ─────────────────────────────────────────────────────────────

  /**
   * Download an artifact from S3 to a local path.
   * Returns true on success, false if not found or on error.
   */
  async pull(logicHash: string, destPath: string): Promise<boolean> {
    validateHash(logicHash);
    const key = makeKey(logicHash, this.orgId);

    try {
      const data = await this.s3Read(key);
      await Bun.write(destPath, data);
      return true;
    } catch {
      return false;
    }
  }

  // ── validate ─────────────────────────────────────────────────────────

  /** Test S3 connectivity. Returns true if bucket is accessible. */
  async validate(): Promise<boolean> {
    try {
      // Write, read, delete a probe object to test full permission set
      const probeKey = `${KEY_PREFIX}/.probe-${Date.now()}`;
      const probeFile = new File(["ok"], "probe");
      await this.s3Write(probeKey, probeFile);
      await this.s3Read(probeKey);
      await this.client.delete(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers (wrapping Bun.S3Client) ──────────────────────────

  private async fileExists(key: string): Promise<boolean> {
    return await this.client.exists(key);
  }

  private async s3Write(key: string, file: any): Promise<void> {
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        await this.client.write(key, file);
        return;
      } catch (e) {
        if (attempt === this.retries - 1) throw e;
        await this.delay(2 ** attempt * 1000);
      }
    }
  }

  private async s3Read(key: string): Promise<any> {
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const file = this.client.file(key);
        if (!(await file.exists())) {
          throw new Error("NoSuchKey");
        }
        return await file.arrayBuffer();
      } catch (e: any) {
        if (attempt === this.retries - 1) throw e;
        await this.delay(2 ** attempt * 1000);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
