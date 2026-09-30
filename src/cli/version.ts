/**
 * @file version.ts
 * @description Resolves the CLI version without ever throwing.
 *
 * `--help` and `--version` must work from every layout the CLI is run in:
 *
 *   src/cli/index.ts      → ../../package.json   (2 levels up, dev)
 *   dist/index.js         → ../package.json      (1 level up, local build)
 *   <prefix>/node_modules/b4mal/dist/index.js → ../../package.json (global install)
 *
 * A fixed relative path is therefore wrong for at least one of these. Instead
 * we walk up from the module's own directory looking for a `package.json`
 * whose `name` is "b4mal", and fall back to a constant baked in at build time.
 * A broken/missing package.json degrades the version string; it never crashes
 * the two most basic CLI invocations.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";

/** Max directory levels to climb while looking for package.json. */
const MAX_ASCENT = 5;

/**
 * Compiled-in fallback, kept in sync with package.json by
 * tests/cli_version.test.ts.
 */
export const FALLBACK_VERSION = "0.1.2";

const PKG_NAME = "b4mal";

/** The bare package name, ignoring any npm scope: "@bneb/b4mal" -> "b4mal". */
function barePackageName(name: unknown): string | null {
    if (typeof name !== "string" || name.length === 0) return null;
    const slash = name.lastIndexOf("/");
    return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Walk upward from `startDir` looking for this package's package.json.
 * Returns the parsed `version` string, or null if none is found.
 *
 * The name is matched on its bare form so both the unscoped `b4mal` and the
 * published scope `@bneb/b4mal` resolve — otherwise scoping the package would
 * silently degrade every invocation to the compiled-in fallback.
 */
function findVersion(startDir: string): string | null {
    let dir = startDir;

    for (let i = 0; i < MAX_ASCENT; i++) {
        try {
            const raw = readFileSync(join(dir, "package.json"), "utf-8");
            const pkg = JSON.parse(raw);
            if (barePackageName(pkg?.name) === PKG_NAME && typeof pkg.version === "string") {
                return pkg.version;
            }
        } catch {
            // Missing, unreadable, or malformed — keep climbing.
        }

        const parent = dirname(dir);
        if (parent === dir) break; // hit the filesystem root
        dir = parent;
    }

    return null;
}

/**
 * The CLI version. Never throws.
 */
export function getVersion(): string {
    try {
        return findVersion(import.meta.dir) ?? FALLBACK_VERSION;
    } catch {
        return FALLBACK_VERSION;
    }
}
