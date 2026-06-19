/**
 * Coverage tests for SQLiteLedger — recordEntry, getEntry, getEntryByLegacyHash.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SQLiteLedger } from "../src/core/sqlite_ledger";

describe("SQLiteLedger", () => {
  let testDir: string;
  let dbPath: string;
  let ledger: SQLiteLedger;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "b4mal-sqlite-"));
    dbPath = join(testDir, "cache.db");
    ledger = new SQLiteLedger(dbPath);
  });

  afterEach(() => {
    try { ledger.close(); } catch {}
    rmSync(testDir, { recursive: true, force: true });
  });

  test("recordEntry and getEntry roundtrip", () => {
    ledger.recordEntry({
      logicHash: "abc123",
      taskId: "build",
      action: "execute",
      timestamp: Date.now(),
      stdout: "output",
      stderr: "",
      durationMs: 100,
    });

    const entry = ledger.getEntry("abc123");
    expect(entry).not.toBeNull();
    expect(entry!.taskId).toBe("build");
    expect(entry!.stdout).toBe("output");
  });

  test("getEntry returns null for unknown hash", () => {
    expect(ledger.getEntry("nonexistent")).toBeNull();
  });

  test("getEntryByLegacyHash with content_hash column", () => {
    ledger.recordEntry({
      logicHash: "hash1",
      contentHash: "hash1",
      taskId: "test",
      action: "execute",
      timestamp: Date.now(),
      stdout: "",
      stderr: "",
      durationMs: 50,
    });

    const entry = ledger.getEntryByLegacyHash("test", "content_hash", "hash1");
    expect(entry).not.toBeNull();
    expect(entry!.taskId).toBe("test");
  });

  test("getEntryByLegacyHash returns null for no match", () => {
    expect(ledger.getEntryByLegacyHash("unknown", "content_hash", "no-match")).toBeNull();
  });

  test("getEntryByLegacyHash with ast_hash column", () => {
    ledger.recordEntry({
      logicHash: "hash2",
      astHash: "hash2",
      taskId: "lint",
      action: "execute",
      timestamp: Date.now(),
      stdout: "",
      stderr: "",
      durationMs: 10,
    });

    const entry = ledger.getEntryByLegacyHash("lint", "ast_hash", "hash2");
    expect(entry).not.toBeNull();
  });

  test("clear removes all entries", () => {
    ledger.recordEntry({
      logicHash: "to-clear",
      taskId: "x",
      action: "execute",
      timestamp: Date.now(),
      stdout: "",
      stderr: "",
      durationMs: 0,
    });
    ledger.clear();
    expect(ledger.getEntry("to-clear")).toBeNull();
  });
});
