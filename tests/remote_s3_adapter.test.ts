/**
 * Tests for S3Adapter using Bun.S3Client.
 * Tests validate behavior through the public API, with mocked S3Client for
 * success-path and retry-logic coverage.
 */

import { describe, test, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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

// ─── Mock-based success path tests ────────────────────────────────────────

describe("S3Adapter with mocked S3Client", () => {
  test("hasArtifact returns true when file exists", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    let receivedKey = "";
    spyOn(adapter as any, "fileExists").mockImplementation(async (key: string) => {
      receivedKey = key;
      return true;
    });
    const result = await adapter.hasArtifact("abc123");
    expect(result).toBe(true);
    expect(receivedKey).toContain("abc123");
    expect(receivedKey).toContain(".tar.zst");
  });

  test("push succeeds when file exists and write succeeds", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    const dir = mkdtempSync(join(tmpdir(), "b4mal-mock-"));
    const tarPath = join(dir, "test.tar.zst");
    writeFileSync(tarPath, "mock-data");
    spyOn(adapter as any, "s3Write").mockResolvedValue(undefined);
    const result = await adapter.push("abc", tarPath);
    expect(result).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("push returns false when file does not exist", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    const result = await adapter.push("abc", "/nonexistent/path.tar.zst");
    expect(result).toBe(false);
  });

  test("pull succeeds when file exists", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    spyOn(adapter as any, "s3Read").mockResolvedValue(Buffer.from("data"));
    const dir = mkdtempSync(join(tmpdir(), "b4mal-mock-"));
    const dest = join(dir, "restored.tar.zst");
    const result = await adapter.pull("abc", dest);
    expect(result).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("pull returns false on S3 error", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    spyOn(adapter as any, "s3Read").mockRejectedValue(new Error("NoSuchKey"));
    const result = await adapter.pull("abc", "/tmp/x");
    expect(result).toBe(false);
  });

  test("s3Write retries on first failure then succeeds", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x", retries: 3 });
    let calls = 0;
    adapter["client"].write = async (_key: string, _file: any) => {
      calls++;
      if (calls === 1) throw new Error("transient error");
    };
    await (adapter as any).s3Write("key", {});
    expect(calls).toBe(2); // Failed once, succeeded on retry
  });

  test("s3Write throws after exhausting retries", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x", retries: 2 });
    adapter["client"].write = async () => { throw new Error("persistent error"); };
    await expect((adapter as any).s3Write("key", {})).rejects.toThrow("persistent error");
  });

  test("s3Read retries on failure", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x", retries: 3 });
    let calls = 0;
    adapter["client"].file = (_key: string) => ({
      exists: async () => { calls++; if (calls <= 1) throw new Error("transient"); return true; },
      arrayBuffer: async () => Buffer.from("data"),
    });
    const result = await (adapter as any).s3Read("key");
    expect(result).toBeDefined();
    expect(calls).toBeGreaterThan(1);
  });

  test("delay resolves after specified ms", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    const start = Date.now();
    await (adapter as any).delay(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });

  test("validate returns true on successful probe", async () => {
    const adapter = new S3Adapter({ bucket: "t", region: "us-east-1", accessKeyId: "x", secretAccessKey: "x" });
    spyOn(adapter as any, "s3Write").mockResolvedValue(undefined);
    spyOn(adapter as any, "s3Read").mockResolvedValue(Buffer.from("ok"));
    // client.delete is called via this.client.delete(probeKey)
    const origDelete = adapter["client"].delete;
    adapter["client"].delete = async (_: string) => {};
    const result = await adapter.validate();
    adapter["client"].delete = origDelete;
    expect(result).toBe(true);
  });
});
