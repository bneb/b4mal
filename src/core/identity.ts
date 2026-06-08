/**
 * @file identity.ts
 * @description Resolves current machine and user identities for execution provenance tracking.
 */

import { ConfigResolver } from "./config_resolver";
import { RustNormalizer } from "./rust_normalizer";

export interface TaskIdentityResult {
    logicHash: string;
    claimHash: string;
    platformHash: string;
}

export class TaskIdentity {
    /**
     * Compute a TaskIdentity from a command string, flags, and environment.
     * Used by the ConfigResolver tests where we classify flags + env into layers.
     */
    static compute(
        command: string,
        flags: string[],
        env: Record<string, string | undefined>
    ): TaskIdentityResult {
        const resolved = ConfigResolver.resolve(flags, env);

        // Logic hash = command + logic-relevant config
        const logicInput = [command, ...resolved.logicRelevant].join("\0");
        const logicHash = hashString(logicInput);

        // Claim hash = claim-relevant config
        const claimInput = resolved.claimRelevant.join("\0");
        const claimHash = hashString(claimInput);

        // Platform hash = platform-relevant config + current OS/arch/version
        const platformInput = [
            process.platform,
            process.arch,
            process.version.split(".")[0], // Major version only
            ...resolved.platformRelevant
        ].join("\0");
        const platformHash = hashString(platformInput);

        return { logicHash, claimHash, platformHash };
    }

    /**
     * Compute a TaskIdentity from raw source code + resource claims.
     * Used by the Identity Engine tests where we hash normalized AST directly.
     *
     * Accepts optional platform overrides for cross-platform testing.
     */
    static fromCode(
        rawCode: string,
        filePath: string,
        resources: string[],
        platform?: string,
        arch?: string,
        version?: string
    ): TaskIdentityResult {
        // ── Layer 1: Logic Hash (AST-normalized, cross-platform) ─────
        let normalizedCode: string;
        if (filePath.endsWith(".rs")) {
            normalizedCode = RustNormalizer.normalize(rawCode).replace(/\s+/g, " ").trim();
        } else {
            // TS/JS: use Bun transpiler for type/comment stripping
            try {
                const transpiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: true });
                normalizedCode = transpiler.transformSync(rawCode).replace(/\s+/g, " ").trim();
            } catch {
                normalizedCode = rawCode.replace(/\s+/g, " ").trim();
            }
        }
        const logicHash = hashString(normalizedCode);

        // ── Layer 2: Claim Hash (resource map, cross-platform) ────
        const sortedResources = [...resources].sort();
        const claimHash = hashString(sortedResources.join("\0"));

        // ── Layer 3: Platform Hash (OS + Arch + Major Version) ───────
        const effectivePlatform = platform || process.platform;
        const effectiveArch = arch || process.arch;
        const effectiveVersion = version || process.version;
        const majorVersion = effectiveVersion.split(".")[0]; // e.g., "v20"

        const platformHash = hashString(
            `${effectivePlatform}\0${effectiveArch}\0${majorVersion}`
        );

        return { logicHash, claimHash, platformHash };
    }
}

// ── Internal: SHA-256 string hasher ──────────────────────────────────────────

function hashString(input: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex");
}
