// B4mal v4.0.0 — Cargo Interceptor (RUSTC_WRAPPER)
//
// Sits between `cargo` and `rustc` via the RUSTC_WRAPPER env var.
// For each rustc invocation:
//   1. Parse the crate name + source file from args
//   2. Compute a logic hash from the compilation unit
//   3. Check the in-memory cache
//   4. Cache hit → skip compilation, return cached artifact
//   5. Cache miss → compile, cache the result

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompilationUnit {
    crateName: string;
    sourceFile: string;
    crateType: string;
    edition: string;
    features: string[];
    args: string[];
}

export interface InterceptResult {
    action: "compile" | "skip";
    cached: boolean;
    artifactPath?: string;
    logicHash?: string;
}

export interface CacheEntry {
    hash: string;
    artifactPath: string;
    timestamp: number;
}

// ─── Interceptor ─────────────────────────────────────────────────────────────

export class CargoInterceptor {
    private db: Database;

    constructor(dbPath: string = join(homedir(), '.b4mal', 'cargo_cache.db')) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath, { create: true });
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cargo_cache (
                hash TEXT PRIMARY KEY,
                artifact_path TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
        `);
    }

    /**
     * Parse the args that cargo passes to RUSTC_WRAPPER.
     *
     * Format: RUSTC_WRAPPER rustc_path --crate-name X ... source.rs ... --crate-type Y
     */
    parseRustcArgs(args: string[]): CompilationUnit {
        let crateName = "";
        let sourceFile = "";
        let crateType = "";
        let edition = "2021";
        const features: string[] = [];

        for (let i = 0; i < args.length; i++) {
            const arg = args[i];

            if (arg === "--crate-name" && i + 1 < args.length) {
                crateName = args[i + 1];
                i++;
            } else if (arg === "--crate-type" && i + 1 < args.length) {
                crateType = args[i + 1];
                i++;
            } else if (arg.startsWith("--edition=")) {
                edition = arg.split("=")[1];
            } else if (arg === "--cfg" && i + 1 < args.length) {
                const cfg = args[i + 1];
                if (cfg.startsWith('feature=')) {
                    features.push(cfg.replace('feature=', '').replace(/"/g, ''));
                }
                i++;
            } else if (
                arg.endsWith(".rs") &&
                !arg.startsWith("-") &&
                !arg.startsWith("/usr") &&
                !arg.includes("rustc")
            ) {
                sourceFile = arg;
            }
        }

        return {
            crateName,
            sourceFile,
            crateType,
            edition,
            features,
            args: args.slice(1), // Strip the rustc binary path
        };
    }

    /**
     * Compute a deterministic logic hash for a compilation unit.
     */
    computeLogicHash(unit: CompilationUnit): string {
        const payload = JSON.stringify({
            crateName: unit.crateName,
            sourceFile: unit.sourceFile,
            crateType: unit.crateType,
            edition: unit.edition,
            features: unit.features.sort(),
        });

        return new Bun.CryptoHasher("sha256")
            .update(payload)
            .digest("hex");
    }

    /**
     * Check the cache for a compilation unit.
     */
    checkCache(unit: CompilationUnit): InterceptResult {
        const hash = this.computeLogicHash(unit);
        const stmt = this.db.query("SELECT artifact_path FROM cargo_cache WHERE hash = $hash");
        const row = stmt.get({ $hash: hash }) as { artifact_path: string } | null;

        if (row) {
            return {
                action: "skip",
                cached: true,
                artifactPath: row.artifact_path,
                logicHash: hash,
            };
        }

        return {
            action: "compile",
            cached: false,
            logicHash: hash,
        };
    }

    /**
     * Store a compiled artifact in the cache.
     */
    cacheStore(hash: string, artifactPath: string): void {
        const stmt = this.db.query(`
            INSERT OR REPLACE INTO cargo_cache (hash, artifact_path, timestamp)
            VALUES ($hash, $path, $ts)
        `);
        stmt.run({
            $hash: hash,
            $path: artifactPath,
            $ts: Date.now(),
        });
    }

    /**
     * Get the number of cached entries.
     */
    getCacheSize(): number {
        const stmt = this.db.query("SELECT COUNT(*) as cnt FROM cargo_cache");
        const row = stmt.get() as { cnt: number } | null;
        return row?.cnt ?? 0;
    }

    /**
     * Clear the entire cache.
     */
    clearCache(): void {
        this.db.exec("DELETE FROM cargo_cache;");
    }
}
