import { SQLiteLedger } from "./core/sqlite_ledger";
import type { Task, TaskResult } from "./schema";
import { generateLogicHash } from "./core/logic_hasher";
import { ArtifactCrypto } from "./core/crypto";

export type CacheHitType = false | "content" | "logic";

export interface CacheMetadata {
    /** Time saved by this cache hit (ms) */
    timeSavedMs?: number;
    /** Number of times this entry has been hit */
    hitCount?: number;
    /** Version that created this entry */
    version?: string;
    /** Cryptographic signature of the content hash */
    signature?: string;
}

export class TaskCache {
    private ledger: SQLiteLedger;
    private crypto: ArtifactCrypto;

    constructor(dbPath: string = ".b4mal/cache.db") {
        this.ledger = new SQLiteLedger(dbPath);
        this.crypto = new ArtifactCrypto();
    }

    /**
     * Provide access to the underlying SQLite database for telemetry aggregation.
     */
    get db(): any {
        return (this.ledger as any).db;
    }

    /**
     * Generate a content-addressable hash for a task definition.
     */
    hashTask(task: Task): string {
        const content = JSON.stringify({
            cmd: task.cmd,
            env: task.env,
            cwd: task.cwd,
        });
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(content);
        return hasher.digest("hex");
    }

    /**
     * Generate a logic-aware hash for a task's command content.
     */
    async logicHashTask(task: Task): Promise<string> {
        const cmdStr = task.cmd.join(" ");
        return generateLogicHash(cmdStr);
    }

    /**
     * Dual-key cache lookup: Content hash first, then logic hash fallback.
     */
    isCached(task: Task, logicHash?: string): TaskResult | null {
        const contentHash = this.hashTask(task);

        // Path A: Content Hit
        const contentEntry = this.ledger.getEntryByLegacyHash(task.id, "content_hash", contentHash);
        if (contentEntry) {
            const meta = this.parseMetadata(contentEntry);
            if (this.crypto.verify(contentHash, meta.signature)) {
                return this.entryToResult(task.id, contentEntry, "content");
            } else {
                console.warn(`[!] Signature verification failed for content hash: ${contentHash}. Treating as cache miss.`);
            }
        }

        // Path B: Logical Hit
        if (logicHash) {
            const logicEntry = this.ledger.getEntryByLegacyHash(task.id, "ast_hash", logicHash);
            if (logicEntry) {
                const meta = this.parseMetadata(logicEntry);
                if (this.crypto.verify(logicEntry.contentHash || "", meta.signature)) {
                    this.bumpHitCount(task.id, logicEntry.logicHash);
                    return this.entryToResult(task.id, logicEntry, "logic");
                } else {
                    console.warn(`[!] Signature verification failed for logic hash: ${logicHash}. Treating as cache miss.`);
                }
            }
        }

        return null;
    }

    private parseMetadata(entry: any): CacheMetadata {
        try {
            return entry.metadata ? JSON.parse(entry.metadata) : {};
        } catch {
            return {};
        }
    }

    private entryToResult(
        taskId: string,
        entry: any,
        hitType: "content" | "logic"
    ): TaskResult {
        return {
            id: taskId,
            exitCode: entry.exitCode ?? 0,
            durationMs: entry.durationMs ?? 0,
            stdout: entry.stdout ?? "",
            stderr: entry.stderr ?? "",
            cacheHit: hitType,
        };
    }

    private bumpHitCount(taskId: string, logicHash: string): void {
        try {
            const entry = this.ledger.getEntry(logicHash);
            if (entry) {
                const meta: CacheMetadata = entry.metadata ? JSON.parse(entry.metadata) : {};
                meta.hitCount = (meta.hitCount ?? 0) + 1;
                entry.metadata = JSON.stringify(meta);
                this.ledger.recordEntry(entry);
            }
        } catch { /* non-critical */ }
    }

    /**
     * Store a task result with both content and logic hashes.
     */
    store(task: Task, result: TaskResult, logicHash?: string, metadata?: Record<string, unknown>): void {
        const contentHash = this.hashTask(task);
        
        const signature = this.crypto.sign(contentHash);
        const metaObj: CacheMetadata = {
            ...(metadata as any ?? {}),
            version: "1.0.0",
            hitCount: 0,
        };
        
        if (signature) {
            metaObj.signature = signature;
        }

        const metaJson = JSON.stringify(metaObj);

        this.ledger.recordEntry({
            logicHash: `legacy:${contentHash}`, // Create a deterministic PK for legacy entries
            taskId: task.id,
            action: "execute",
            timestamp: Date.now(),
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            metadata: metaJson,
            contentHash: contentHash,
            astHash: logicHash,
            exitCode: result.exitCode,
        });
    }

    /**
     * Clear all cached results.
     */
    clear(): void {
        this.ledger.clear();
    }

    close(): void {
        this.ledger.close();
    }
}
