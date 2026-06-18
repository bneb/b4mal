/**
 * Config loader: reads b4mal.config.json, validates against B4malConfigSchema,
 * converts to TaskConfigWithId array, and writes b4mal.lock atomically.
 */
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, realpathSync, rmSync } from "fs";
import { join, dirname, sep } from "path";
import { randomBytes, createHash } from "crypto";
import {
  B4malConfigSchema,
  type B4malConfig,
  type TaskConfigWithId,
} from "./schema";

// ─── Helpers ───────────────────────────────────────────────────────────────

function sortStrings(a: string, b: string): number {
  // Locale-independent comparison for cross-platform determinism
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedSet(arr: string[]): string[] {
  return [...new Set(arr)].sort(sortStrings);
}

function sortedRecordKeys(rec: Record<string, string> | undefined): Record<string, string> {
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(rec).sort(sortStrings)) {
    out[k] = rec[k];
  }
  return out;
}

// ─── loadConfig ────────────────────────────────────────────────────────────

/**
 * Load and validate b4mal.config.json from the given project root.
 * Throws on missing file, invalid JSON, or schema validation failure.
 * Rejects config files resolved through symlinks outside projectRoot.
 */
export function loadConfig(projectRoot: string): B4malConfig {
  const configPath = join(projectRoot, "b4mal.config.json");

  if (!existsSync(configPath)) {
    throw new Error(
      `Configuration file not found: b4mal.config.json (searched in ${projectRoot}). ` +
      `Run 'b4mal init' to create one.`
    );
  }

  // Symlink traversal protection
  let realConfigPath: string;
  let realRoot: string;
  try {
    realConfigPath = realpathSync(configPath);
    realRoot = realpathSync(projectRoot);
  } catch (e: any) {
    throw new Error(
      `Cannot resolve config file path: ${e.message}. ` +
      `Check that b4mal.config.json exists and is accessible.`
    );
  }

  // Normalize separators for cross-platform safety (Windows uses backslash)
  const rootPrefix = realRoot.replace(/\\/g, "/") + "/";
  const normConfig = realConfigPath.replace(/\\/g, "/");
  if (!normConfig.startsWith(rootPrefix) && normConfig !== realRoot.replace(/\\/g, "/")) {
    throw new Error(
      `Config file resolves outside project root: ${realConfigPath}. ` +
      `Symlinks to files outside the project are not allowed.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e: any) {
    throw new Error(`Failed to parse b4mal.config.json: ${e.message}`);
  }

  const result = B4malConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration in b4mal.config.json:\n${issues}`
    );
  }

  return result.data;
}

// ─── configToTasks ─────────────────────────────────────────────────────────

/**
 * Convert a validated B4malConfig into a deterministic, sorted array
 * of TaskConfigWithId suitable for writing to b4mal.lock.
 *
 * This is a PURE FUNCTION — no filesystem access, no side effects.
 * Output is deterministically sorted for cross-platform reproducibility.
 */
export function configToTasks(config: B4malConfig): TaskConfigWithId[] {
  const ids = Object.keys(config.tasks).sort(sortStrings);

  return ids.map(id => {
    const t = config.tasks[id];

    // Normalize backslashes in all path-like fields (defense in depth —
    // Zod transform handles this for validated configs, but direct callers
    // may pass raw objects with undefined fields).
    const norm = (arr: string[] | undefined): string[] =>
      sortedSet((arr ?? []).map(p => p.replace(/\\/g, "/")));

    const task: TaskConfigWithId = {
      id,
      cmd: [...t.cmd],
      dependencies: sortedSet(t.dependencies),
      inputs: norm(t.inputs),
      outputs: norm(t.outputs),
      claims: norm(t.claims),
      needsEnv: sortedSet(t.needsEnv),
      providesEnv: sortedSet(t.providesEnv),
      env: sortedRecordKeys(t.env),
      timeout: t.timeout,
      cache: t.cache,
    };

    if (t.cwd) {
      task.cwd = t.cwd.replace(/\\/g, "/");
    }

    return task;
  });
}

// ─── writeLockfileAtomic ───────────────────────────────────────────────────

/**
 * Write tasks to b4mal.lock atomically using a temp-file + rename pattern.
 * Prevents partial writes and corruption from concurrent processes.
 *
 * The lockfile uses an envelope format:
 *   { "version": 2, "_meta": { "configHash": "sha256:..." }, "tasks": [...] }
 */
export function writeLockfileAtomic(tasks: TaskConfigWithId[], lockPath: string): void {
  const configHash = computeConfigHash(tasks);
  const envelope = {
    version: 2,
    _meta: { configHash },
    tasks,
  };

  const json = JSON.stringify(envelope, null, 2);

  // Write to a temp file in the same directory as the lockfile to ensure
  // atomic rename (POSIX guarantees atomic rename within the same filesystem).
  const dir = dirname(lockPath);
  const tmpName = `.b4mal-lock-${randomBytes(8).toString("hex")}.tmp`;
  const tmpPath = join(dir, tmpName);

  try {
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, lockPath);
  } catch (e) {
    // Clean up temp file on failure
    try { if (existsSync(tmpPath)) rmSync(tmpPath); } catch {}
    throw e;
  }
}

function computeConfigHash(tasks: TaskConfigWithId[]): string {
  const hash = createHash("sha256");
  // Hash the normalized JSON of tasks only (not the envelope)
  hash.update(JSON.stringify(tasks));
  return `sha256:${hash.digest("hex")}`;
}

// ─── isConfigStale ─────────────────────────────────────────────────────────

/**
 * Returns true if b4mal.config.json exists and the lockfile is absent or stale.
 * Config exists + no lockfile → true (needs generation)
 * Config exists + lockfile older → true (stale)
 * Config absent → false
 * Config exists + lockfile same age or newer → false
 */
export function isConfigStale(projectRoot: string): boolean {
  const configPath = join(projectRoot, "b4mal.config.json");
  const lockPath = join(projectRoot, "b4mal.lock");

  if (!existsSync(configPath)) return false;
  if (!existsSync(lockPath)) return true; // lockfile absent, config exists

  const configMtime = statSync(configPath).mtimeMs;
  const lockMtime = statSync(lockPath).mtimeMs;

  return configMtime > lockMtime;
}
