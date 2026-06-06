// tests/state_boundary.test.ts — v4.1.0 "The State Boundary" (RED-to-GREEN)
//
// Environment sanitization + SQLite persistent cache ledger

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { EnvSanitizer } from "../src/guard/env_sanitizer";
import { SQLiteLedger, type CacheEntry } from "../src/core/sqlite_ledger";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — Environment Sanitization
// ═══════════════════════════════════════════════════════════════════════════

describe("EnvSanitizer — Host Bleed Prevention", () => {
    test("TOP_SECRET_KEY is stripped from sanitized env", () => {
        const hostEnv: Record<string, string> = {
            PATH: "/usr/bin",
            HOME: "/home/dev",
            TOP_SECRET_KEY: "hunter2",
            AWS_SECRET_ACCESS_KEY: "AKIA...",
            DATABASE_URL: "postgres://...",
        };

        const cleaned = EnvSanitizer.sanitize([], hostEnv);

        expect(cleaned["PATH"]).toBe("/usr/bin");
        expect(cleaned["HOME"]).toBe("/home/dev");
        expect(cleaned["TOP_SECRET_KEY"]).toBeUndefined();
        expect(cleaned["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
        expect(cleaned["DATABASE_URL"]).toBeUndefined();
    });

    test("only POSIX whitelist passes through with zero claims", () => {
        const hostEnv: Record<string, string> = {
            PATH: "/usr/bin",
            HOME: "/home/dev",
            USER: "kevin",
            TMPDIR: "/tmp",
            TERM: "xterm-256color",
            GITHUB_TOKEN: "ghp_xxx",
            NODE_ENV: "production",
            STRIPE_KEY: "sk_live_xxx",
        };

        const cleaned = EnvSanitizer.sanitize([], hostEnv);

        expect(Object.keys(cleaned).sort()).toEqual(
            ["HOME", "PATH", "TERM", "TMPDIR", "USER"]
        );
    });
});

describe("EnvSanitizer — Claim Passthrough", () => {
    test("claimed env var is injected into sanitized env", () => {
        const hostEnv: Record<string, string> = {
            PATH: "/usr/bin",
            HOME: "/home/dev",
            API_PORT: "8080",
            RUST_LOG: "debug",
            SECRET_THING: "nope",
        };

        const cleaned = EnvSanitizer.sanitize(["API_PORT", "RUST_LOG"], hostEnv);

        expect(cleaned["API_PORT"]).toBe("8080");
        expect(cleaned["RUST_LOG"]).toBe("debug");
        expect(cleaned["SECRET_THING"]).toBeUndefined();
    });

    test("claiming a nonexistent env var does not crash", () => {
        const hostEnv: Record<string, string> = {
            PATH: "/usr/bin",
        };

        const cleaned = EnvSanitizer.sanitize(["DOES_NOT_EXIST"], hostEnv);

        expect(cleaned["DOES_NOT_EXIST"]).toBeUndefined();
        expect(cleaned["PATH"]).toBe("/usr/bin");
    });
});

describe("EnvSanitizer — Subprocess Integration", () => {
    test("spawned process cannot see unclaimed host variables", async () => {
        const hostEnv: Record<string, string> = {
            PATH: process.env.PATH ?? "/usr/bin",
            HOME: process.env.HOME ?? "/tmp",
            TOP_SECRET_KEY: "123",
            API_PORT: "9090",
        };

        const sanitized = EnvSanitizer.sanitize(["API_PORT"], hostEnv);

        const proc = Bun.spawn(["printenv"], {
            stdout: "pipe",
            stderr: "pipe",
            env: sanitized,
        });

        const stdout = await new Response(proc.stdout).text();
        await proc.exited;

        // TOP_SECRET_KEY must NOT appear
        expect(stdout).not.toContain("TOP_SECRET_KEY");
        // API_PORT must appear
        expect(stdout).toContain("API_PORT=9090");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — SQLite Persistent Ledger
// ═══════════════════════════════════════════════════════════════════════════

describe("SQLiteLedger — Persistence", () => {
    let dbDir: string;

    beforeEach(async () => {
        dbDir = path.join(os.tmpdir(), "b4mal-sqlite-test-" + Date.now());
        await fs.mkdir(dbDir, { recursive: true });
    });

    afterAll(async () => {
        // Cleanup is best-effort
    });

    test("recorded entry survives close and reopen", () => {
        const dbPath = path.join(dbDir, "test1.db");

        // Instance 1: write
        const ledger1 = new SQLiteLedger(dbPath);
        ledger1.recordEntry({
            logicHash: "abc123",
            taskId: "compile-core",
            action: "execute",
            timestamp: 1000,
        });
        ledger1.close();

        // Instance 2: read from the same file
        const ledger2 = new SQLiteLedger(dbPath);
        const entry = ledger2.getEntry("abc123");
        ledger2.close();

        expect(entry).not.toBeNull();
        expect(entry!.logicHash).toBe("abc123");
        expect(entry!.taskId).toBe("compile-core");
        expect(entry!.action).toBe("execute");
        expect(entry!.timestamp).toBe(1000);
    });

    test("getEntry returns null for unknown hash", () => {
        const dbPath = path.join(dbDir, "test2.db");
        const ledger = new SQLiteLedger(dbPath);

        const entry = ledger.getEntry("nonexistent");
        ledger.close();

        expect(entry).toBeNull();
    });

    test("INSERT OR REPLACE updates existing entry", () => {
        const dbPath = path.join(dbDir, "test3.db");
        const ledger = new SQLiteLedger(dbPath);

        ledger.recordEntry({
            logicHash: "hash1",
            taskId: "task-old",
            action: "execute",
            timestamp: 1000,
        });

        ledger.recordEntry({
            logicHash: "hash1",
            taskId: "task-new",
            action: "skip",
            timestamp: 2000,
        });

        const entry = ledger.getEntry("hash1");
        ledger.close();

        expect(entry!.taskId).toBe("task-new");
        expect(entry!.action).toBe("skip");
        expect(entry!.timestamp).toBe(2000);
    });

    test("WAL mode is enabled", () => {
        const dbPath = path.join(dbDir, "test4.db");
        const ledger = new SQLiteLedger(dbPath);

        const mode = ledger.getJournalMode();
        ledger.close();

        expect(mode).toBe("wal");
    });
});

describe("SQLiteLedger — WAL Concurrency Stress", () => {
    test("50 concurrent writes do not throw SQLITE_BUSY", async () => {
        const dbDir = path.join(os.tmpdir(), "b4mal-wal-stress-" + Date.now());
        await fs.mkdir(dbDir, { recursive: true });
        const dbPath = path.join(dbDir, "stress.db");

        const ledger = new SQLiteLedger(dbPath);

        // Fire 50 concurrent recordEntry calls
        const writes = Array.from({ length: 50 }, (_, i) => {
            return new Promise<void>((resolve, reject) => {
                try {
                    ledger.recordEntry({
                        logicHash: `hash-${i}`,
                        taskId: `task-${i}`,
                        action: i % 2 === 0 ? "execute" : "skip",
                        timestamp: Date.now() + i,
                    });
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });

        // All 50 must succeed without SQLITE_BUSY
        await expect(Promise.all(writes)).resolves.toBeDefined();

        // Verify all 50 are present
        let count = 0;
        for (let i = 0; i < 50; i++) {
            const entry = ledger.getEntry(`hash-${i}`);
            if (entry) count++;
        }

        ledger.close();

        expect(count).toBe(50);

        await fs.rm(dbDir, { recursive: true, force: true });
    });
});
