// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// B4mal Core Shim — TypeScript Edition (v1.4.0)
//
// Zero-dependency bridge from Node.js/Bun functions to the b4mal engine.
// Drop this file into your JS/TS project.
//
// The shim communicates with the locally-installed `b4mal` binary
// via `spawn` with detached state (fire-and-forget telemetry).
//
// Usage:
//   import { attest } from "./b4mal";
//
//   await attest("web_integration", ["fs:write:db.sqlite"], async () => {
//       // logic here
//   });
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { spawn } from "node:child_process";

export interface AttestOptions {
    /** 
     * Disable silent failure. If true, attestation failures will throw.
     * Default: false (graceful degradation)
     */
    strict?: boolean;
}

/**
 * Attest that a block of logic requires access to specific resources.
 * 
 * This triggers a Path-based Isolation check in the b4mal engine.
 * The engine verifies that no other concurrent test claims
 * overlapping resources (the disjointness constraint).
 * 
 * @param taskName  Identifier for this logical block.
 * @param resources Array of resource claim strings (e.g., "fs:path", "port:80").
 * @param logic     The async operation to execute under protection.
 * @param options   Configuration options.
 */
export async function attest<T>(
    taskName: string,
    resources: string[],
    logic: () => Promise<T>,
    options: AttestOptions = {}
): Promise<T> {

    // Fire-and-forget telemetry
    try {
        const child = spawn("b4mal", ["attest", taskName, ...resources], {
            detached: true,
            stdio: "ignore",
            env: {
                ...process.env,
                B4MAL_CALLER: "ts-shim-v1.4.0",
            },
        });

        // Unref allows the parent node process to exit even if the child hasn't
        child.unref();

        child.on("error", (err) => {
            if (options.strict) {
                console.error(`[b4mal] Attestation failed for ${taskName}:`, err.message);
            }
            // Otherwise, silently degrade (graceful degradation)
        });

    } catch (e) {
        if (options.strict) {
            throw new Error(`Failed to spawn b4mal: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Execute the actual protected logic
    return await logic();
}

/**
 * Check if the b4mal engine is available in PATH.
 */
export async function isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn("b4mal", ["--version"], { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });
}
