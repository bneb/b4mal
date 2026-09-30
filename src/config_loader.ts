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
function resolveConfigPath(projectRoot: string): string {
  const configPath = join(projectRoot, "b4mal.config.json");
  if (existsSync(configPath)) return configPath;

  // `b4mal init` generates b4mal.lock; it does not create a b4mal.config.json.
  // The old message told people to run init here — but anyone reaching this error
  // had typically just done exactly that, so it sent them in a circle: init
  // cannot produce the file the command needs, and re-running it changes nothing.
  //
  // The two cases need different advice. With a lock already present the user has
  // a buildable project and asked for a sync they cannot have, so the fix is to
  // drop --sync. With nothing present, init is genuinely the right next step.
  if (existsSync(join(projectRoot, "b4mal.lock"))) {
    throw new Error(
      `No b4mal.config.json found (searched in ${projectRoot}).\n` +
      `  A b4mal.lock already exists — run 'b4mal build' to use it.\n` +
      `  Rebuilding the lock from a config needs a b4mal.config.json;\n` +
      `  'b4mal init' creates a lockfile, not a config.`
    );
  }
  throw new Error(
    `No b4mal.config.json found (searched in ${projectRoot}).\n` +
    `  Run 'b4mal init' to generate a b4mal.lock from your project, or write a\n` +
    `  b4mal.config.json to make the config the source of truth.`
  );
}

function verifyPathBoundary(configPath: string, projectRoot: string): void {
  let realConfigPath: string;
  let realRoot: string;
  try {
    realConfigPath = realpathSync(configPath);
    realRoot = realpathSync(projectRoot);
  } catch (e: any) {
    throw new Error(`Cannot resolve config file path: ${e.message}. Check that b4mal.config.json exists and is accessible.`);
  }
  const rootPrefix = realRoot.replace(/\\/g, "/") + "/";
  const normConfig = realConfigPath.replace(/\\/g, "/");
  if (!normConfig.startsWith(rootPrefix) && normConfig !== realRoot.replace(/\\/g, "/")) {
    throw new Error(`Config file resolves outside project root: ${realConfigPath}. Symlinks to external files are not allowed.`);
  }
}

function readAndValidate(configPath: string): B4malConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e: any) {
    throw new Error(`Failed to parse b4mal.config.json: ${e.message}`);
  }
  const result = B4malConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration in b4mal.config.json:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(projectRoot: string): B4malConfig {
  const configPath = resolveConfigPath(projectRoot);
  verifyPathBoundary(configPath, projectRoot);
  return readAndValidate(configPath);
}

// ─── configToTasks ─────────────────────────────────────────────────────────

/**
 * Convert discovered/lockfile tasks into an authored b4mal.config.json object.
 *
 * This is the inverse of configToTasks, used by `b4mal init` so a fresh project
 * gets BOTH artifacts from one source: init writes this config, then derives
 * b4mal.lock from it through the normal Zod-validated path. The two cannot drift
 * because the lock is computed from the config, not discovered independently.
 *
 * Field handling that matters:
 *
 * - Task IDs are sanitized. npm script names are legal but b4mal task IDs are
 *   not: `test:unit`, `@scope/thing` and `a.b` are real script names that the
 *   config schema rejects (VALID_TASK_ID allows only alphanumerics, dashes and
 *   underscores). init used to write those straight into the lock, which has no
 *   write-time ID check, so they worked; routing them through the validated
 *   config path is what surfaced it. Sanitizing here keeps every discovered
 *   project init-able while preserving the exact command, which is what actually
 *   runs.
 *
 * - Lockfile field names are mapped to config names (deps→dependencies,
 *   reads→inputs, writes→outputs, envReads→needsEnv, envWrites→providesEnv).
 * - `fs:`-prefixed entries in `claims` are dropped. A discovered task carries the
 *   same path in both `claims: ["fs:src/x.ts"]` and `reads: ["src/x.ts"]`; the
 *   planner folds every fs: claim into BOTH reads and writes. Re-emitting both
 *   would make an input-only task look like it also writes that path, which is a
 *   false collision. Inputs/outputs already express the fs resource; only
 *   non-filesystem claims (env:, db:, port:) are carried in `claims`.
 * - Empty collections are omitted so the emitted config reads like one a human
 *   wrote — the schema defaults fill the rest.
 *
 * PURE — no filesystem access, no side effects.
 */
/**
 * Turn an arbitrary discovered id (often a raw npm script name like
 * `test:unit`, `@scope/thing`, `a.b`) into a schema-valid b4mal task ID
 * (alphanumerics, dashes, underscores), guaranteeing uniqueness against ids
 * already emitted.
 *
 * Only the task key changes; the command the task runs is untouched, so
 * `test:unit` becomes task `test-unit` but still executes `npm run test:unit`.
 * If sanitising produces a name that collides with an existing id, a numeric
 * suffix is appended.
 */
function uniqueTaskId(rawId: string, existing: Record<string, any>): string {
  const base = String(rawId)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^-+/, "")      // an id may not start with a dash
    .replace(/-+$/, "");     // nor end with one
  let id = base || "task";  // a name of only invalid characters collapses here
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(existing, id)) {
    id = `${base || "task"}-${n++}`;
  }
  return id;
}

export function tasksToConfigWithReport(
  tasks: any[],
  projectName?: string,
): { config: Record<string, any>; prunedEdges: string[] } {
  const config: Record<string, any> = {};
  if (projectName) config.name = projectName;

  const list = tasks ?? [];

  // Pass 1 — settle every id before emitting anything, because a sanitised id
  // has to be remapped in the tasks that depend on it. Sanitising inside the
  // emit loop would emit `dependsOn: ["test:unit"]` for a task now called
  // `test-unit`, and that edge would dangle.
  const idMap = new Map<string, string>();
  const taken: Record<string, any> = {};
  for (const raw of list) {
    const id = uniqueTaskId(String((raw as any).id), taken);
    idMap.set(String((raw as any).id), id);
    taken[id] = true;
  }

  // Pass 2 — emit.
  //
  // Discovery produces a *best-effort* graph, and the config schema is stricter
  // than the lockfile ever was: it rejects dangling edges and cycles. Both were
  // previously writable into the lock and only discovered at plan time; routing
  // init through the validated path surfaced them on real repositories.
  //
  // An inferred edge that does not hold up is not trustworthy, so it is dropped —
  // but never silently. Every removed edge is reported so `b4mal init` can tell
  // the user their graph was pruned instead of claiming a clean success.
  const allIds = new Set(idMap.values());
  const pruned: string[] = [];
  /** Edges accepted so far, used to break cycles deterministically. */
  const accepted = new Map<string, string[]>();

  const canReach = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of accepted.get(from) ?? []) {
      if (canReach(next, target, seen)) return true;
    }
    return false;
  };

  const out: Record<string, any> = {};
  for (const raw of list) {
    const t = raw as any;
    const reads: string[] = t.reads ?? t.inputs ?? [];
    const writes: string[] = t.writes ?? t.outputs ?? [];
    // Keep only non-filesystem claims; fs paths live in inputs/outputs.
    const claims: string[] = (t.claims ?? []).filter((c: string) => !String(c).startsWith("fs:"));
    const envReads: string[] = t.envReads ?? t.needsEnv ?? [];
    const envWrites: string[] = t.envWrites ?? t.providesEnv ?? [];

    const id = idMap.get(String(t.id))!;

    // Dependencies point at the new ids; keep only those that resolve to a real
    // task and do not close a cycle. Tasks sorted by id so the result is stable.
    const requested: string[] = (t.deps ?? t.dependencies ?? []).map((d: string) => idMap.get(d) ?? d);
    const deps: string[] = [];
    for (const dep of requested.slice().sort()) {
      if (!allIds.has(dep)) {
        pruned.push(`${id} → ${dep} (no such task)`);
        continue;
      }
      if (dep === id || canReach(dep, id)) {
        pruned.push(`${id} → ${dep} (would create a dependency cycle)`);
        continue;
      }
      deps.push(dep);
    }
    accepted.set(id, deps);

    const task: Record<string, any> = { cmd: t.cmd ?? [] };
    if (deps.length) task.dependencies = deps;
    if (reads.length) task.inputs = reads;
    if (writes.length) task.outputs = writes;
    if (claims.length) task.claims = claims;
    if (envReads.length) task.needsEnv = envReads;
    if (envWrites.length) task.providesEnv = envWrites;
    if ((t.secrets ?? []).length) task.secrets = t.secrets;
    if (t.env && Object.keys(t.env).length) task.env = t.env;
    if (t.cwd) task.cwd = t.cwd;
    if (typeof t.timeout === "number" && t.timeout !== 300_000) task.timeout = t.timeout;
    if (t.cache === false) task.cache = false;
    if (t.when) task.when = t.when;

    out[id] = task;
  }

  config.tasks = out;
  return { config, prunedEdges: pruned };
}

export function tasksToConfig(tasks: any[], projectName?: string): Record<string, any> {
  return tasksToConfigWithReport(tasks, projectName).config;
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
  const tasks: TaskConfigWithId[] = [];

  for (const id of ids) {
    const t = config.tasks[id];
    const matrix = (t as any).matrix as Record<string, string[]> | undefined;

    if (matrix) {
      // Expand matrix: cartesian product of axis values
      const expanded = expandMatrix(id, t as any, matrix);
      tasks.push(...expanded);
    } else {
      tasks.push(buildTask(id, t as any));
    }
  }

  // Detect ID collisions (can happen when manual task name matches expanded matrix name)
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new Error(`Duplicate task ID after matrix expansion: "${task.id}". Check for collisions between manual task names and matrix-generated names.`);
    }
    seen.add(task.id);
  }

  return tasks;
}

const VALID_MATRIX_VALUE = /^[a-zA-Z0-9_.-]+$/;

function validateMatrixAxes(baseId: string, axes: string[], matrix: Record<string, string[]>): void {
  for (const axis of axes) {
    if (!VALID_MATRIX_VALUE.test(axis)) {
      throw new Error(`Matrix axis name "${axis}" contains invalid characters. Use [a-zA-Z0-9_.-]`);
    }
    if (matrix[axis].length === 0) {
      throw new Error(`Matrix axis "${axis}" for task "${baseId}" has zero values`);
    }
    const invalidVal = matrix[axis].find(v => !VALID_MATRIX_VALUE.test(v));
    if (invalidVal) {
      throw new Error(`Matrix value "${invalidVal}" in axis "${axis}" contains invalid characters. Use [a-zA-Z0-9_.-]`);
    }
  }
}

function cartesianProduct(axes: string[], matrix: Record<string, string[]>): Record<string, string>[] {
  return axes.reduce((combos, axis) => {
    const sortedVals = matrix[axis].slice().sort(sortStrings);
    return combos.flatMap(combo =>
      sortedVals.map(val => ({ ...combo, [axis]: val }))
    );
  }, [{}] as Record<string, string>[]);
}

function expandMatrix(
  baseId: string,
  t: Record<string, any>,
  matrix: Record<string, string[]>,
): TaskConfigWithId[] {
  const axes = Object.keys(matrix).sort(sortStrings);
  if (axes.length === 0) return [buildTask(baseId, t)];
  validateMatrixAxes(baseId, axes, matrix);
  const combinations = cartesianProduct(axes, matrix);
  return combinations.map((combo) => {
    const suffix = axes.map(a => `${a}=${combo[a]}`).join("-");
    return buildTask(`${baseId}-${suffix}`, t, combo);
  });
}

function buildTask(
  id: string,
  t: Record<string, any>,
  matrixVars?: Record<string, string>,
): TaskConfigWithId {
  const norm = (arr: string[] | undefined): string[] =>
    sortedSet((arr ?? []).map((p: string) => p.replace(/\\/g, "/")));

  const env = sortedRecordKeys(t.env ?? {});
  if (matrixVars) {
    for (const [k, v] of Object.entries(matrixVars)) {
      env[`MATRIX_${k.toUpperCase()}`] = v;
    }
  }

  const task: TaskConfigWithId = {
    id,
    cmd: t.cmd ?? [],
    dependencies: sortedSet(t.dependencies ?? []),
    inputs: norm(t.inputs),
    outputs: norm(t.outputs),
    claims: norm(t.claims),
    needsEnv: sortedSet(t.needsEnv ?? []),
    providesEnv: sortedSet(t.providesEnv ?? []),
    secrets: sortedSet(t.secrets ?? []),
    env,
    timeout: t.timeout ?? 300_000,
    cache: t.cache ?? true,
    when: t.when,
  };
  if (t.cwd) task.cwd = (t.cwd as string).replace(/\\/g, "/");
  return task;
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
