/**
 * @file cache_key.ts
 * @description Computes the content-addressed cache key for a task.
 *
 * DETERMINISM REQUIREMENT
 * -----------------------
 * The README's core invariant is: "If a task is executed with the exact same
 * inputs, it must yield the exact same outputs." The cache key must therefore be
 * a pure function of a task's *declared inputs*.
 *
 * The previous implementation hashed `task.claims`, which the engine builds as
 * `inputs + outputs + claims`. For any task that declares outputs, the key
 * therefore depended on the content of the very file the task writes — a
 * self-referential key. Consequences, all observed in practice:
 *
 *   - The key is undefined before the task first runs (output absent).
 *   - It changes as a result of the task running.
 *   - Any leftover output from a previous run, or another task writing the same
 *     path, silently changes the key and produces a miss.
 *
 * So identical inputs produced different cache outcomes depending on unrelated
 * workspace state. The fix: a task's own outputs are excluded from its key.
 */

import { join } from "path";
import { ContentHasher } from "../core/content_hasher";

/**
 * Version salt for the key scheme.
 *
 * Bump this whenever the set of hashed inputs changes. Without it, entries
 * written by an older scheme could be read back as hits by a newer one, because
 * both hash a plain SHA-256 over different input sets with no discriminator.
 */
export const CACHE_KEY_VERSION = "b4mal-cache-key-v2";

export interface CacheKeyTask {
    id: string;
    cmd: string[];
    reads?: string[];
    writes?: string[];
    claims?: string[];
    /** Names of environment variables the task reads; their values are hashed. */
    envReads?: string[];
}

/** Canonical form of an fs path for comparison and hashing. */
export function normalizeFsPath(p: string): string {
    return p
        .replace(/^fs:/, "")
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
}

/**
 * True when a declared write at `writePath` lands on, or inside, `inputPath`
 * (a write to a directory covers every path beneath it).
 */
export function writeCovers(writePath: string, inputPath: string): boolean {
    const w = normalizeFsPath(writePath);
    const i = normalizeFsPath(inputPath);
    if (w.length === 0) return false;
    return i === w || i.startsWith(`${w}/`);
}

/**
 * The paths that participate in the cache key: everything the task may observe
 * (declared reads plus declared fs claims) minus everything it produces.
 *
 * Returned sorted, so the key does not depend on declaration order.
 */
export function cacheKeyInputs(task: CacheKeyTask): string[] {
    const outputs = (task.writes ?? []).map(normalizeFsPath);

    const candidates = new Set<string>();
    for (const read of task.reads ?? []) {
        candidates.add(normalizeFsPath(read));
    }
    for (const claim of task.claims ?? []) {
        if (claim.startsWith("fs:")) candidates.add(normalizeFsPath(claim));
    }

    return [...candidates]
        .filter(p => p.length > 0)
        .filter(p => !outputs.some(w => writeCovers(w, p)))
        .sort();
}

/**
 * Compute the task's cache key from its declared inputs.
 *
 * Returns undefined only when no project root is available (nothing to hash
 * paths against).
 */
export async function computeCacheKey(
    task: CacheKeyTask,
    projectRoot: string,
): Promise<string | undefined> {
    if (!projectRoot) return undefined;

    const writes = task.writes ?? [];
    // Tasks that produce artifacts are keyed on raw input content; tasks that
    // produce nothing (typecheck, test) use the AST-normalized "logic" hash so
    // comment-only edits do not invalidate them.
    const useLogicHash = writes.length === 0;

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(CACHE_KEY_VERSION);
    hasher.update("\0");
    hasher.update(task.id);
    hasher.update("\0");
    hasher.update(JSON.stringify(task.cmd));
    hasher.update("\0");

    for (const input of cacheKeyInputs(task)) {
        const inputHash = await ContentHasher.hashPath(
            join(projectRoot, input),
            { useLogicHash, projectRoot },
        );
        hasher.update(input);
        hasher.update("\0");
        hasher.update(inputHash);
        hasher.update("\0");
    }

    // Declared environment variables are inputs. Without hashing their values a
    // changed variable (NODE_ENV, RUST_LOG, a feature flag) produced a stale
    // cache hit, which ARCHITECTURE.md explicitly promises does not happen.
    for (const name of [...new Set(task.envReads ?? [])].sort()) {
        const value = process.env[name];
        hasher.update("env\0");
        hasher.update(name);
        hasher.update("\0");
        // Distinguish "unset" from "set to empty string".
        hasher.update(value === undefined ? "\0unset" : `\0set\0${value}`);
        hasher.update("\0");
    }

    return hasher.digest("hex");
}
