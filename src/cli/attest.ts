// B4mal v1.3.0 — Attest Command Handler
//
// Engine-side handler for the `b4mal attest` CLI command.
// Parses resource claims from the Rust shim's std::process::Command
// args and converts them to TaskResourceClaims for FormalShadow.
//
// Resource prefix format:
//   fs:<path>           → read (default)
//   fs:read:<path>      → read
//   fs:write:<path>     → write
//   env:<var>            → envRead (default)
//   env:write:<var>      → envWrite
//   port:<number>        → write (exclusive)

import type { TaskResourceClaim } from "../core/formal_shadow";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AttestArgs {
    taskName: string;
    reads: string[];
    writes: string[];
    envReads: string[];
    envWrites: string[];
    ports: string[];
}

export interface CallerInfo {
    name: string;
    version: string;
}

export interface AttestResult {
    accepted: boolean;
    taskName: string;
    caller?: CallerInfo;
    claim?: TaskResourceClaim;
    error?: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AttestHandler {
    /**
     * Parse raw CLI args into structured AttestArgs.
     * First arg is task name, rest are resource claims.
     */
    static parseArgs(args: string[]): AttestArgs {
        const taskName = args[0] ?? "";
        const reads: string[] = [];
        const writes: string[] = [];
        const envReads: string[] = [];
        const envWrites: string[] = [];
        const ports: string[] = [];

        for (let i = 1; i < args.length; i++) {
            const arg = args[i];

            if (arg.startsWith("fs:write:")) {
                writes.push(arg.slice(9));
            } else if (arg.startsWith("fs:read:")) {
                reads.push(arg.slice(8));
            } else if (arg.startsWith("fs:")) {
                reads.push(arg.slice(3)); // bare fs: defaults to read
            } else if (arg.startsWith("env:write:")) {
                envWrites.push(arg.slice(10));
            } else if (arg.startsWith("env:")) {
                envReads.push(arg.slice(4));
            } else if (arg.startsWith("port:")) {
                ports.push(arg.slice(5));
            }
        }

        return { taskName, reads, writes, envReads, envWrites, ports };
    }

    /**
     * Identify the calling shim from B4MAL_CALLER env var.
     * Format: "name-vX.Y.Z"
     */
    static identifyCaller(env: Record<string, string | undefined>): CallerInfo {
        const caller = env.B4MAL_CALLER;
        if (!caller) return { name: "unknown", version: "unknown" };

        // Parse "rust-shim-v1.3.0" → name="rust-shim", version="v1.3.0"
        const vIdx = caller.lastIndexOf("-v");
        if (vIdx === -1) return { name: caller, version: "unknown" };

        return {
            name: caller.slice(0, vIdx),
            version: caller.slice(vIdx + 1),
        };
    }

    /**
     * Convert parsed args to a TaskResourceClaim for FormalShadow.
     * Ports are modeled as writes (exclusive access).
     */
    static toClaim(args: AttestArgs): TaskResourceClaim {
        return {
            id: args.taskName,
            reads: [...args.reads],
            writes: [...args.writes, ...args.ports.map(p => `port:${p}`)],
            envReads: [...args.envReads],
            envWrites: [...args.envWrites],
        };
    }

    /**
     * Execute the attest command end-to-end.
     * Graceful degradation: never throws, always returns a result.
     */
    static async execute(
        args: string[],
        env: Record<string, string | undefined>
    ): Promise<AttestResult> {
        try {
            if (args.length === 0 || !args[0]) {
                return { accepted: false, taskName: "", error: "Missing task name" };
            }

            const parsed = this.parseArgs(args);
            const caller = this.identifyCaller(env);
            const claim = this.toClaim(parsed);

            return {
                accepted: true,
                taskName: parsed.taskName,
                caller,
                claim,
            };
        } catch (e) {
            return {
                accepted: false,
                taskName: args[0] ?? "",
                error: `Attestation failed: ${e instanceof Error ? e.message : String(e)}`,
            };
        }
    }
}
