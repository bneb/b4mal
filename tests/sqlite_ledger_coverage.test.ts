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

// ─── B4MAL_DB_PATH override ──────────────────────────────────────────────────
//
// Isolated runs — notably the dogfood test, which asserts it does not touch the
// developer's cache — set B4MAL_DB_PATH. The ledger ignored it, so every such
// run silently wrote to the project's real `.b4mal/cache.db`.

describe("SQLiteLedger — B4MAL_DB_PATH override", () => {
  let dir: string;
  const original = process.env.B4MAL_DB_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4mal-dbpath-"));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.B4MAL_DB_PATH;
    else process.env.B4MAL_DB_PATH = original;
    rmSync(dir, { recursive: true, force: true });
  });

  test("redirects the ledger away from the requested path", () => {
    const requested = join(dir, "project", ".b4mal", "cache.db");
    const override = join(dir, "isolated.db");
    process.env.B4MAL_DB_PATH = override;

    const led = new SQLiteLedger(requested);
    try {
      led.recordEntry({
        logicHash: "isolated-key",
        taskId: "t",
        action: "execute",
        timestamp: Date.now(),
        stdout: "",
        stderr: "",
        durationMs: 1,
      });
    } finally {
      led.close();
    }

    const { existsSync } = require("fs");
    expect(existsSync(override)).toBe(true);
    expect(existsSync(requested)).toBe(false);
  });

  test("honours the requested path when the override is unset", () => {
    delete process.env.B4MAL_DB_PATH;
    const requested = join(dir, "project", ".b4mal", "cache.db");

    const led = new SQLiteLedger(requested);
    led.close();

    expect(require("fs").existsSync(requested)).toBe(true);
  });

  test("ignores a blank override", () => {
    process.env.B4MAL_DB_PATH = "   ";
    const requested = join(dir, "project", ".b4mal", "cache.db");

    const led = new SQLiteLedger(requested);
    led.close();

    expect(require("fs").existsSync(requested)).toBe(true);
  });
});
