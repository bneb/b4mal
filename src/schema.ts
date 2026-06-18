/**
 * B4mal v7.1.0 — Schema Layer
 *
 * Canonical task and config types. TaskConfig is the single source of truth
 * used by the orchestrator, executor, verifier, and config loader.
 *
 * Legacy types (TaskSchema, PipelineSchema, etc.) are retained for
 * backwards compatibility with existing tests and the v1 engine path.
 * They will be removed after test migration.
 */
import { z } from "zod";

// ─── Path Sanitization ─────────────────────────────────────────────────────

/**
 * Rejects absolute paths, path traversal (..), and normalizes
 * backslashes to forward slashes for cross-platform determinism.
 */
export function sanitizePath(p: string): string {
  if (p.startsWith("/")) {
    throw new Error(`Absolute paths not allowed: "${p}"`);
  }
  // Check for path traversal segments (not substring matches)
  if (p.split("/").some(seg => seg === "..")) {
    throw new Error(`Path traversal not allowed: "${p}"`);
  }
  return p.replace(/\\/g, "/");
}

// ─── Canonical Task Config ─────────────────────────────────────────────────

export const TaskConfigSchema = z.object({
  /** Command and arguments (passed directly to Bun.spawn) */
  cmd: z.array(z.string()).min(1, "cmd must contain at least one element"),

  /** Task IDs that must complete before this one starts */
  dependencies: z.array(z.string()).default([]),

  /** Filesystem paths this task reads (relative to project root) */
  inputs: z.array(z.string()).default([])
    .transform(ps => ps.map(sanitizePath)),

  /** Filesystem paths this task writes (relative to project root) */
  outputs: z.array(z.string()).default([])
    .transform(ps => ps.map(sanitizePath)),

  /** Non-filesystem resource claims (e.g. "env:PORT", "db:local", "port:8080") */
  claims: z.array(z.string()).default([]),

  /** Env var names this task reads (for resource-conflict detection) */
  needsEnv: z.array(z.string()).default([]),

  /** Env var names this task writes (for resource-conflict detection) */
  providesEnv: z.array(z.string()).default([]),

  /** Secret names this task requires (resolved at runtime, never hashed) */
  secrets: z.array(z.string()).default([]),

  /** Conditional execution: skip task unless conditions are met */
  when: z.object({
    branch: z.string().optional().describe("Glob pattern for branch name"),
    platform: z.array(z.string()).optional().describe("OS platforms to run on"),
    if: z.string().optional().describe("Arbitrary condition expression"),
  }).optional(),

  /** Matrix build: generate N task instances from axis values */
  matrix: z.record(z.array(z.string())).optional().describe("Axis values for matrix expansion"),

  /** Extra env vars to inject when spawning this task */
  env: z.record(z.string()).default({}),

  /** Working directory relative to project root */
  cwd: z.string().optional()
    .transform(p => p ? p.replace(/\\/g, "/") : p)
    .refine(
      p => !p || (!p.startsWith("/") && !p.split("/").some(seg => seg === "..")),
      "cwd must be a relative path within the project root"
    ),

  /** Timeout in milliseconds (0 = use default of 5 minutes, max 1 hour) */
  timeout: z.number().int().nonnegative().max(3_600_000)
    .transform(t => t === 0 ? 300_000 : t)
    .default(300_000),

  /** Whether to cache this task's output (default true) */
  cache: z.boolean().default(true),
});

export type TaskConfig = z.infer<typeof TaskConfigSchema>;

/** TaskConfig with id populated (lockfile/orchestrator form, after configToTasks conversion) */
export interface TaskConfigWithId extends TaskConfig {
  id: string;
  secrets: string[];
  when?: { branch?: string; platform?: string[]; if?: string };
}

// ─── Project Config ────────────────────────────────────────────────────────

const VALID_TASK_ID = /^[a-zA-Z0-9_-]+$/;

function validTaskIds(tasks: Record<string, TaskConfig>): boolean {
  return Object.keys(tasks).every(k => VALID_TASK_ID.test(k));
}

function allDepsResolve(tasks: Record<string, TaskConfig>): boolean {
  const ids = new Set(Object.keys(tasks));
  for (const task of Object.values(tasks)) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) return false;
    }
  }
  return true;
}

function hasNoCycles(tasks: Record<string, TaskConfig>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of Object.keys(tasks)) color.set(id, WHITE);

  function dfs(id: string): boolean {
    const c = color.get(id);
    if (c === GRAY) return false; // back edge = cycle
    if (c === BLACK) return true;
    color.set(id, GRAY);
    for (const dep of tasks[id]?.dependencies ?? []) {
      if (!dfs(dep)) return false;
    }
    color.set(id, BLACK);
    return true;
  }

  for (const id of color.keys()) {
    if (color.get(id) === WHITE && !dfs(id)) return false;
  }
  return true;
}

export const B4malConfigSchema = z.object({
  /** Project name (defaults to directory name if omitted) */
  name: z.string().optional(),

  /** Task definitions keyed by ID (order-independent) */
  tasks: z.record(TaskConfigSchema).refine(
    tasks => Object.keys(tasks).length > 0,
    "At least one task is required"
  ).refine(
    validTaskIds,
    { message: "Task IDs must contain only alphanumeric characters, dashes, and underscores" }
  ).refine(
    allDepsResolve,
    { message: "All dependency references must resolve to existing task IDs" }
  ).refine(
    hasNoCycles,
    { message: "Circular dependency detected in task dependencies" }
  ),

  /** Max parallel tasks (0 = unbounded) */
  concurrency: z.number().int().nonnegative().default(0),

  /** Base env inherited by all tasks */
  env: z.record(z.string()).default({}),
});

export type B4malConfig = z.infer<typeof B4malConfigSchema>;

// ─── Legacy Schema (deprecated — remove after test migration) ──────────────

export const TaskSchema = z.object({
  id: z.string().min(1),
  cmd: z.array(z.string()).min(1),
  env: z.record(z.string()).default({}),
  dependencies: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  timeout: z.number().int().nonnegative().default(0),
});

export type Task = z.infer<typeof TaskSchema>;

export const TaskResultSchema = z.object({
  id: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  cacheHit: z.union([z.literal(false), z.literal("content"), z.literal("logic")]).default(false),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

export const PipelineSchema = z.object({
  name: z.string().min(1),
  tasks: z.array(TaskSchema).min(1),
  concurrency: z.number().int().nonnegative().default(0),
  env: z.record(z.string()).default({}),
});

export type Pipeline = z.infer<typeof PipelineSchema>;

export const PipelineResultSchema = z.object({
  name: z.string(),
  tasks: z.array(TaskResultSchema),
  totalDurationMs: z.number(),
  overheadMs: z.number(),
  success: z.boolean(),
});

export type PipelineResult = z.infer<typeof PipelineResultSchema>;
