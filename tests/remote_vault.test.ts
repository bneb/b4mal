/**
 * Tests for RemoteVault — L2 cache orchestration.
 *
 * Tests focus on:
 * 1. Metadata embedding/parsing (pure functions, no S3 needed)
 * 2. Disabled state (null adapter = no-op)
 * 3. Graceful degradation (S3 errors → null/fallback)
 */

import { describe, test, expect } from "bun:test";
import {
  RemoteVault,
  embedMetadata,
  parseEmbeddedMetadata,
  type CacheMetadata,
} from "../src/core/remote_vault";
import { S3Adapter } from "../src/remote/s3_adapter";

// ─── Metadata Embedding ────────────────────────────────────────────────────

describe("embedMetadata", () => {
  test("embeds metadata as length-prefixed JSON header", () => {
    const meta: CacheMetadata = {
      logicHash: "abc123",
      taskId: "build",
      exitCode: 0,
      durationMs: 1234,
      signature: null,
    };

    const data = Buffer.from("zstd-compressed-data-here");
    const result = embedMetadata(data, meta);

    // Should be: [4-byte LE length][JSON][data]
    expect(result.length).toBeGreaterThan(data.length);

    // First 4 bytes = JSON length
    const jsonLen = result.readUInt32LE(0);
    expect(jsonLen).toBeGreaterThan(0);

    // JSON starts at byte 4
    const jsonBytes = result.subarray(4, 4 + jsonLen);
    const parsed = JSON.parse(jsonBytes.toString("utf-8"));
    expect(parsed.logicHash).toBe("abc123");
    expect(parsed.taskId).toBe("build");
    expect(parsed.exitCode).toBe(0);

    // Remainder is the original data
    const remainder = result.subarray(4 + jsonLen);
    expect(remainder.toString()).toBe("zstd-compressed-data-here");
  });
});

// ─── parseEmbeddedMetadata ────────────────────────────────────────────────

describe("parseEmbeddedMetadata", () => {
  test("extracts metadata from valid archive", () => {
    const meta: CacheMetadata = {
      logicHash: "abc", taskId: "test",
      exitCode: 0, durationMs: 50, signature: null,
    };
    const data = Buffer.from("zstd-data");
    const archive = embedMetadata(data, meta);

    const parsed = parseEmbeddedMetadata(archive);
    expect(parsed).not.toBeNull();
    expect(parsed!.logicHash).toBe("abc");
    expect(parsed!.taskId).toBe("test");
    expect(parsed!.exitCode).toBe(0);
    expect(parsed!.durationMs).toBe(50);
  });

  test("returns null on empty buffer", () => {
    expect(parseEmbeddedMetadata(Buffer.alloc(0))).toBeNull();
  });

  test("returns null on buffer too small for header", () => {
    expect(parseEmbeddedMetadata(Buffer.from([0x01, 0x00, 0x00, 0x00]))).toBeNull();
  });

  test("returns null on corrupt length (exceeds data)", () => {
    const buf = Buffer.alloc(100);
    buf.writeUInt32LE(9999, 0); // length 9999 > 100 bytes
    expect(parseEmbeddedMetadata(buf)).toBeNull();
  });

  test("returns null on invalid JSON in header", () => {
    const buf = Buffer.alloc(20);
    buf.writeUInt32LE(10, 0);
    buf.write("not-valid-json", 4);
    expect(parseEmbeddedMetadata(buf)).toBeNull();
  });

  test("handles metadata with signature field", () => {
    const meta: CacheMetadata = {
      logicHash: "xyz",
      taskId: "deploy",
      exitCode: 1,
      durationMs: 999,
      signature: "hmac-sha256:abcdef123456",
    };
    const archive = embedMetadata(Buffer.from("data"), meta);
    const parsed = parseEmbeddedMetadata(archive);
    expect(parsed!.signature).toBe("hmac-sha256:abcdef123456");
  });
});

// ─── Disabled State ────────────────────────────────────────────────────────

describe("disabled state (null adapter)", () => {
  test("checkAndPull returns null when adapter is null", async () => {
    const vault = new RemoteVault(null);
    const result = await vault.checkAndPull("abc123", "/tmp");
    expect(result).toBeNull();
  });

  test("pushWithMetadata returns false when adapter is null", async () => {
    const vault = new RemoteVault(null);
    const result = await vault.pushWithMetadata("abc123", "/tmp", {
      logicHash: "abc", taskId: "x", exitCode: 0, durationMs: 0, signature: null,
    });
    expect(result).toBe(false);
  });

  test("lastPromoted is null by default", () => {
    const vault = new RemoteVault(null);
    expect(vault.lastPromoted).toBeNull();
  });
});

// ─── Graceful Degradation ──────────────────────────────────────────────────

describe("graceful degradation (S3 errors)", () => {
  test("checkAndPull returns null when S3 is unreachable", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "fake", secretAccessKey: "fake",
    });
    const vault = new RemoteVault(adapter);

    // With fake creds, S3 will fail — should return null, not throw
    const result = await vault.checkAndPull("abc123", "/tmp/project");
    expect(result).toBeNull();
  });

  test("pushWithMetadata returns false when S3 is unreachable", async () => {
    const adapter = new S3Adapter({
      bucket: "test", region: "us-east-1",
      accessKeyId: "fake", secretAccessKey: "fake",
    });
    const vault = new RemoteVault(adapter);

    const result = await vault.pushWithMetadata("abc123", "/tmp/project", {
      logicHash: "abc", taskId: "x", exitCode: 0, durationMs: 0, signature: null,
    });
    expect(result).toBe(false);
  });
});

// ─── Roundtrip ────────────────────────────────────────────────────────────

describe("embed/parse roundtrip", () => {
  test("roundtrips all metadata fields", () => {
    const original: CacheMetadata = {
      logicHash: "sha256:abcdef1234567890",
      taskId: "integration-test",
      exitCode: 0,
      durationMs: 4567,
      signature: "hmac-sha256:somesignaturevalue",
    };

    const archive = embedMetadata(Buffer.from("realistic-zstd-binary-data"), original);
    const extracted = parseEmbeddedMetadata(archive);

    expect(extracted).toEqual(original);
  });
});
