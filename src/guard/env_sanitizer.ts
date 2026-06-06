// B4mal v4.1.0 — Strict Environment Sanitizer
//
// Strips the host process.env before passing it to Bun.spawn().
// Only variables on the POSIX whitelist + explicitly claimed env
// keys are allowed through. Everything else is dropped.
//
// This closes the "Environment Bleed" vulnerability identified
// in the v4.0.0 due diligence audit.

// ─── Sanitizer ───────────────────────────────────────────────────────────────

export class EnvSanitizer {
    /**
     * Minimal POSIX whitelist: only the variables required for
     * a subprocess to function on a Unix system.
     */
    private static readonly WHITELIST = new Set([
        "PATH",
        "HOME",
        "USER",
        "TMPDIR",
        "TERM",
    ]);

    /**
     * Construct a sanitized environment object for Bun.spawn().
     *
     * @param claimedEnvs - Raw env keys from Z3-verified claims
     *                      (e.g. ["RUST_LOG", "NODE_ENV"])
     * @param hostEnv     - The host's process.env
     * @returns A clean env object containing ONLY whitelisted +
     *          claimed variables. All other keys are dropped.
     */
    static sanitize(
        claimedEnvs: string[],
        hostEnv: Record<string, string | undefined>,
    ): Record<string, string> {
        const cleanEnv: Record<string, string> = {};

        // 1. Apply POSIX whitelist
        for (const key of this.WHITELIST) {
            if (hostEnv[key] !== undefined) {
                cleanEnv[key] = hostEnv[key]!;
            }
        }

        // 2. Apply Z3-verified claims
        for (const key of claimedEnvs) {
            if (hostEnv[key] !== undefined) {
                cleanEnv[key] = hostEnv[key]!;
            }
            // If the host doesn't have this var, we omit it silently.
            // No crash. No empty string injection.
        }

        return cleanEnv;
    }
}
