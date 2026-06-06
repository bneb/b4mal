/**
 * @file core_bootstrap.ts
 * @description Initializes the B4mal engine, instantiating the ledger, vault, and planner components.
 */

import { mkdir } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";
import { ProjectScanner } from "./project_scanner";
import { generateForecast, type ForecastResult } from "../shim/forecaster";
import { SQLiteLedger } from "./sqlite_ledger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BootstrapResult {
    success: boolean;
    steps: {
        identity: boolean;
        state: boolean;
        forecast: boolean;
    };
    forecast?: ForecastResult;
    durationMs: number;
}

export interface BootstrapOptions {
    /** Force overwrite existing certs */
    force?: boolean;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export class CoreBootstrap {
    /**
     * Execute the Core Bootstrap sequence.
     */
    static async init(
        projectDir: string,
        options?: BootstrapOptions
    ): Promise<BootstrapResult> {
        const start = performance.now();
        const b4malDir = join(projectDir, ".b4mal");
        const certsDir = join(b4malDir, "certs");
        const dbPath = join(b4malDir, "cache.db");
        const force = options?.force ?? false;

        const steps = { identity: false, state: false, forecast: false };
        let forecast: ForecastResult | undefined;

        // ── 1. Directory Structure ────────────────────────────────────────
        await mkdir(certsDir, { recursive: true });

        // ── 2. Identity Generation (mTLS Certs) ──────────────────────────
        steps.identity = await this.generateIdentity(certsDir, force);

        // ── 3. State Provisioning ─────────────────────────────────────────
        steps.state = this.provisionState(dbPath);

        // ── 4. Core Forecast ─────────────────────────────────────────
        try {
            const sourceFiles = await ProjectScanner.scanSourceFiles(projectDir);
            const files = sourceFiles.map(f => ({
                path: f.path,
                content: f.content,
            }));
            // Use a synthetic task count estimate based on project size
            const estimatedTasks = Math.max(1, Math.ceil(files.length / 5));
            forecast = generateForecast(estimatedTasks, files);
            steps.forecast = true;
        } catch {
            steps.forecast = true; // Non-fatal
            forecast = generateForecast(1);
        }

        return {
            success: steps.identity && steps.state && steps.forecast,
            steps,
            forecast,
            durationMs: performance.now() - start,
        };
    }

    /**
     * Generate self-signed CA + client certificates.
     * Skips if certs already exist (unless force=true).
     */
    private static async generateIdentity(
        certsDir: string,
        force: boolean
    ): Promise<boolean> {
        const caKeyPath = join(certsDir, "ca.key");
        const caCertPath = join(certsDir, "ca.crt");
        const clientKeyPath = join(certsDir, "client.key");
        const clientCertPath = join(certsDir, "client.crt");

        // Check if certs already exist
        const caExists = await Bun.file(caCertPath).exists();
        if (caExists && !force) {
            return true; // Already initialized
        }

        try {
            // Generate CA key
            const caKey = await Bun.spawn(
                ["openssl", "genrsa", "-out", caKeyPath, "2048"],
                { stderr: "pipe" }
            );
            await caKey.exited;

            // Generate CA cert
            const caCert = await Bun.spawn(
                [
                    "openssl", "req", "-new", "-x509",
                    "-key", caKeyPath,
                    "-out", caCertPath,
                    "-days", "365",
                    "-subj", "/CN=b4mal-core-ca",
                ],
                { stderr: "pipe" }
            );
            await caCert.exited;

            // Generate client key
            const clientKey = await Bun.spawn(
                ["openssl", "genrsa", "-out", clientKeyPath, "2048"],
                { stderr: "pipe" }
            );
            await clientKey.exited;

            // Generate client CSR and sign with CA
            const csrPath = join(certsDir, "client.csr");
            const clientCsr = await Bun.spawn(
                [
                    "openssl", "req", "-new",
                    "-key", clientKeyPath,
                    "-out", csrPath,
                    "-subj", "/CN=b4mal-core-client",
                ],
                { stderr: "pipe" }
            );
            await clientCsr.exited;

            const clientCert = await Bun.spawn(
                [
                    "openssl", "x509", "-req",
                    "-in", csrPath,
                    "-CA", caCertPath,
                    "-CAkey", caKeyPath,
                    "-CAcreateserial",
                    "-out", clientCertPath,
                    "-days", "365",
                ],
                { stderr: "pipe" }
            );
            await clientCert.exited;

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Initialize the SQLite state store with the Universal Ledger schema.
     */
    private static provisionState(dbPath: string): boolean {
        try {
            // Instantiating SQLiteLedger automatically creates the latest schema
            const ledger = new SQLiteLedger(dbPath);

            // Access underlying database for metadata table
            const db = (ledger as any).db as Database;

            db.exec(`
                CREATE TABLE IF NOT EXISTS b4mal_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT DEFAULT (datetime('now'))
                );
            `);

            // Set first_flight if not already present
            const existing = db.query(
                "SELECT value FROM b4mal_meta WHERE key = 'first_flight'"
            ).get();

            if (!existing) {
                db.query(
                    "INSERT INTO b4mal_meta (key, value) VALUES ('first_flight', ?)"
                ).run(new Date().toISOString());
            }

            ledger.close();
            return true;
        } catch {
            return false;
        }
    }
}
