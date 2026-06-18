/**
 * Tests for S3Adapter using Bun.S3Client.
 * Tests validate behavior through the public API — no mocking internals.
 */

import { describe, test, expect } from "bun:test";
import { S3Adapter, type S3Config } from "../src/remote/s3_adapter";

// ─── S3Config validation ──────────────────────────────────────────────────

describe("S3Config", () => {
  test("rejects missing bucket", () => {
    expect(() => new S3Adapter({ accessKeyId: "x", secretAccessKey: "x", region: "us-east-1" } as any)).toThrow();
  });

  test("rejects missing accessKeyId", () => {
    expect(() => new S3Adapter({ bucket: "b", secretAccessKey: "x", region: "us-east-1" } as any)).toThrow();
  });

  test("rejects missing secretAccessKey", () => {
    expect(() => new S3Adapter({ bucket: "b", accessKeyId: "x", region: "us-east-1" } as any)).toThrow();
  });

  test("accepts minimal valid config", () => {
    const config: S3Config = {
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "AKIATEST",
      secretAccessKey: "test-secret",
    };
    expect(() => new S3Adapter(config)).not.toThrow();
  });

  test("accepts config with custom endpoint (R2/MinIO)", () => {
    const config: S3Config = {
      bucket: "test-bucket",
      region: "auto",
      accessKeyId: "AKIATEST",
      secretAccessKey: "test-secret",
      endpoint: "https://s3.example.com",
    };
    expect(() => new S3Adapter(config)).not.toThrow();
  });

  test("accepts config with org prefix for multi-tenant", () => {
    const config: S3Config = {
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "AKIATEST",
      secretAccessKey: "test-secret",
      orgId: "my-org",
    };
    const adapter = new S3Adapter(config);
    expect(adapter).toBeDefined();
  });
});

// ─── hasArtifact (invalid input) ──────────────────────────────────────────

describe("hasArtifact", () => {
  test("rejects invalid logicHash with path traversal", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    await expect(adapter.hasArtifact("../escape")).rejects.toThrow();
  });

  test("rejects logicHash with special characters", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    await expect(adapter.hasArtifact("hash with spaces")).rejects.toThrow();
  });

  test("accepts valid hex logicHash", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    // Will try to connect to S3 but that's fine — tests the validation only
    await expect(adapter.hasArtifact("abc123def456")).resolves.toBe(false);
  });
});

// ─── push (invalid input) ─────────────────────────────────────────────────

describe("push", () => {
  test("rejects invalid logicHash", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    await expect(adapter.push("../escape", "/tmp/test")).rejects.toThrow();
  });

  test("returns false for non-existent file", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    // File doesn't exist, but push catches and returns false
    const result = await adapter.push("abc123", "/nonexistent/path.tar.zst");
    expect(result).toBe(false);
  });
});

// ─── pull (invalid input) ─────────────────────────────────────────────────

describe("pull", () => {
  test("rejects invalid logicHash", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    await expect(adapter.pull("../escape", "/tmp/test")).rejects.toThrow();
  });

  test("returns false when S3 is unreachable (no real credentials)", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });
    // Will fail to connect to real S3 — should catch and return false
    const result = await adapter.pull("abc123", "/tmp/dest");
    expect(result).toBe(false);
  });
});

// ─── validate ─────────────────────────────────────────────────────────────

describe("validate", () => {
  test("returns false with invalid credentials (graceful)", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "fake", secretAccessKey: "fake",
    });
    const result = await adapter.validate();
    expect(result).toBe(false);
  });
});

// ─── Key format (tested via internal structure) ───────────────────────────

describe("cache key format", () => {
  test("key is validated before any S3 operation", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });

    // All three public methods reject bad keys before touching S3
    await expect(adapter.hasArtifact("bad key!")).rejects.toThrow();
    await expect(adapter.push("bad key!", "/tmp/x")).rejects.toThrow();
    await expect(adapter.pull("bad key!", "/tmp/x")).rejects.toThrow();
  });

  test("valid hex hashes pass validation", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "x", secretAccessKey: "x",
    });

    // These should attempt S3 (and fail due to no real creds) but NOT throw on validation
    await expect(adapter.hasArtifact("abc-123_def.456")).resolves.toBe(false);
    await expect(adapter.hasArtifact("a1b2c3d4e5f6")).resolves.toBe(false);
  });
});
