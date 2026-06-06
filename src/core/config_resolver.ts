/**
 * @file config_resolver.ts
 * @description Resolves workspace configurations, merging local overrides with root project definitions.
 */

export interface ResolvedConfig {
    /** Env vars and flags that affect code path selection (feature flags, cfg) */
    logicRelevant: string[];
    /** Env vars and flags that affect resource claims (paths, ports) */
    claimRelevant: string[];
    /** Env vars and flags that affect binary output (opt-level, target) */
    platformRelevant: string[];
}

// ── Noise Blacklist ──────────────────────────────────────────────────────────
// These env vars NEVER affect logic, claims, or platform identity.

const NOISE_VARS = new Set([
    // Logging / display
    "RUST_LOG", "LOG_LEVEL", "DEBUG", "VERBOSE", "TRACE",
    // Terminal / editor
    "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
    "EDITOR", "VISUAL", "PAGER", "LESS", "LSCOLORS", "LS_COLORS",
    // Shell session
    "SHELL", "SHLVL", "OLDPWD", "PWD", "_", "LANG", "LC_ALL", "LC_CTYPE",
    // User context (non-functional)
    "USER", "LOGNAME", "HOME", "TMPDIR", "XDG_RUNTIME_DIR",
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
    // PATH is noise for identity purposes — changing PATH doesn't change logic
    "PATH", "MANPATH", "INFOPATH",
    // SSH / session
    "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CONNECTION", "SSH_TTY",
    // macOS specific
    "COMMAND_MODE", "__CF_USER_TEXT_ENCODING", "Apple_PubSub_Socket_Render",
    // CI noise
    "CI", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL",
    "BUILD_NUMBER", "BUILD_ID", "JOB_NAME",
]);

// ── Flag Classification ──────────────────────────────────────────────────────

/** Flags that affect logic (conditional compilation) */
const LOGIC_FLAG_PREFIXES = ["--cfg", "--features", "--feature", "-F"];

/** Flags that affect platform/binary output */
const PLATFORM_FLAG_PREFIXES = [
    "-C", "--codegen",
    "--target", "-target",
    "--edition",
];

/** Env vars that contain logic-altering content (parsed for --cfg, features) */
const LOGIC_ENV_VARS = new Set(["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]);

/** Env vars that affect resource claims */
const CLAIM_ENV_VARS = new Set([
    "CARGO_TARGET_DIR", "CARGO_HOME", "OUT_DIR",
    "DATABASE_URL", "PORT",
]);

export class ConfigResolver {
    /**
     * Classify a set of environment variables and compiler flags
     * into the three identity layers. All outputs are deterministically sorted.
     */
    static resolve(
        flags: string[],
        env: Record<string, string | undefined>
    ): ResolvedConfig {
        const logicRelevant: string[] = [];
        const claimRelevant: string[] = [];
        const platformRelevant: string[] = [];

        // ── Classify flags ───────────────────────────────────────────────
        // We process flags in pairs where needed (e.g., "-C opt-level=3")
        const sortedFlags = [...flags].sort();

        for (let i = 0; i < sortedFlags.length; i++) {
            const flag = sortedFlags[i];

            if (LOGIC_FLAG_PREFIXES.some(p => flag.startsWith(p))) {
                // Logic-altering: grab the flag and its value (next arg if separate)
                logicRelevant.push(flag);
                if (i + 1 < sortedFlags.length && !sortedFlags[i + 1].startsWith("-")) {
                    logicRelevant.push(sortedFlags[++i]);
                }
            } else if (PLATFORM_FLAG_PREFIXES.some(p => flag.startsWith(p))) {
                platformRelevant.push(flag);
                if (i + 1 < sortedFlags.length && !sortedFlags[i + 1].startsWith("-")) {
                    platformRelevant.push(sortedFlags[++i]);
                }
            } else {
                // Default: treat unknown flags as logic-relevant (conservative)
                logicRelevant.push(flag);
            }
        }

        // ── Classify env vars ────────────────────────────────────────────
        const sortedKeys = Object.keys(env).sort();

        for (const key of sortedKeys) {
            const val = env[key];
            if (val === undefined) continue;

            // Skip noise
            if (NOISE_VARS.has(key)) continue;

            // Logic env vars (RUSTFLAGS may contain --cfg)
            if (LOGIC_ENV_VARS.has(key)) {
                logicRelevant.push(`${key}=${val}`);
                continue;
            }

            // Claim env vars (paths, ports)
            if (CLAIM_ENV_VARS.has(key)) {
                claimRelevant.push(`${key}=${val}`);
                continue;
            }

            // Default: treat unknown env vars as claim-relevant (conservative)
            claimRelevant.push(`${key}=${val}`);
        }

        return {
            logicRelevant: logicRelevant.sort(),
            claimRelevant: claimRelevant.sort(),
            platformRelevant: platformRelevant.sort(),
        };
    }
}
