/**
 * @file sqlite_ledger.ts
 * @description Maintains a high-throughput SQLite WAL log of execution history and cache hits.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
    logicHash: string;
    taskId: string;
    action: "skip" | "execute";
    timestamp: number;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    metadata?: string;
    contentHash?: string;
    astHash?: string;
    exitCode?: number;
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

export class SQLiteLedger {
    private db: Database;

    /**
     * Open or create a SQLite ledger at the given path.
     * Enables WAL mode and creates the schema if absent.
     */
    constructor(dbPath: string) {
        // Ensure parent directory exists
        mkdirSync(dirname(dbPath), { recursive: true });

        this.db = new Database(dbPath, { create: true });

        // WAL for concurrent read/write safety
        this.db.exec("PRAGMA journal_mode = WAL;");

        // Busy timeout: wait up to 5s if another writer holds the lock
        this.db.exec("PRAGMA busy_timeout = 5000;");

        // Schema v3: Universal Ledger
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cache_ledger (
                logic_hash   TEXT PRIMARY KEY,
                task_id      TEXT    NOT NULL,
                action       TEXT    NOT NULL,
                timestamp    INTEGER NOT NULL,
                stdout       TEXT,
                stderr       TEXT,
                duration_ms  REAL,
                metadata     TEXT,
                content_hash TEXT,
                ast_hash     TEXT,
                exit_code    INTEGER DEFAULT 0
            );

            -- Indexes for legacy v1.0 / v0.5.0 lookups
            CREATE INDEX IF NOT EXISTS idx_content_hash ON cache_ledger (task_id, content_hash);
            CREATE INDEX IF NOT EXISTS idx_ast_hash     ON cache_ledger (task_id, ast_hash);
        `);
    }

    /**
     * Look up a cache entry by its logic hash.
     */
    getEntry(logicHash: string): CacheEntry | null {
        const stmt = this.db.query(
            "SELECT * FROM cache_ledger WHERE logic_hash = $hash"
        );
        const row = stmt.get({ $hash: logicHash }) as any;

        if (!row) return null;

        return this.mapRowToEntry(row);
    }

    /**
     * Look up a cache entry by task_id and a specific hash column (for legacy fallback).
     */
    getEntryByLegacyHash(taskId: string, column: "content_hash" | "ast_hash", hash: string): CacheEntry | null {
        const stmt = this.db.query(
            `SELECT * FROM cache_ledger WHERE task_id = $id AND ${column} = $hash AND exit_code = 0 ORDER BY timestamp DESC LIMIT 1`
        );
        const row = stmt.get({ $id: taskId, $hash: hash }) as any;

        if (!row) return null;

        return this.mapRowToEntry(row);
    }

    private mapRowToEntry(row: any): CacheEntry {
        return {
            logicHash: row.logic_hash,
            taskId: row.task_id,
            action: row.action,
            timestamp: row.timestamp,
            stdout: row.stdout ?? undefined,
            stderr: row.stderr ?? undefined,
            durationMs: row.duration_ms ?? undefined,
            metadata: row.metadata ?? undefined,
            contentHash: row.content_hash ?? undefined,
            astHash: row.ast_hash ?? undefined,
            exitCode: row.exit_code ?? undefined,
        };
    }

    /**
     * Record a cache entry. Upserts on logic_hash conflict.
     */
    recordEntry(entry: CacheEntry): void {
        const stmt = this.db.query(`
            INSERT OR REPLACE INTO cache_ledger (
                logic_hash, task_id, action, timestamp, stdout, stderr, duration_ms, metadata, content_hash, ast_hash, exit_code
            )
            VALUES ($logic, $id, $action, $ts, $stdout, $stderr, $duration, $meta, $content, $ast, $exit)
        `);
        stmt.run({
            $logic: entry.logicHash,
            $id: entry.taskId,
            $action: entry.action,
            $ts: entry.timestamp,
            $stdout: entry.stdout ?? null,
            $stderr: entry.stderr ?? null,
            $duration: entry.durationMs ?? null,
            $meta: entry.metadata ?? null,
            $content: entry.contentHash ?? null,
            $ast: entry.astHash ?? null,
            $exit: entry.exitCode ?? 0,
        });
    }

    /**
     * Return the current journal mode (should be "wal").
     */
    getJournalMode(): string {
        const stmt = this.db.query("PRAGMA journal_mode;");
        const row = stmt.get() as { journal_mode: string } | null;
        return row?.journal_mode ?? "unknown";
    }

    /**
     * Count total entries in the ledger.
     */
    count(): number {
        const stmt = this.db.query("SELECT COUNT(*) as cnt FROM cache_ledger");
        const row = stmt.get() as { cnt: number } | null;
        return row?.cnt ?? 0;
    }

    /**
     * Drop all cache entries from the ledger.
     */
    clear(): void {
        this.db.exec("DELETE FROM cache_ledger;");
    }

    /**
     * Close the database connection.
     */
    close(): void {
        this.db.close();
    }
}
