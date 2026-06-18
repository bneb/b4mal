# Design Plan: b4mal.config.json — User-Facing Configuration (v2)

## Status: Phase 3 — WRITE TESTS (design passed red team, round 2 clean)

## Red Team Summary

### Round 1 (original design)

| Lens | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Security | 1 (C-1: code exec via import()) | 3 (H-1: tar traversal, H-2: env injection, H-3: stale lockfile) | 5 | 5 |
| Correctness | 1 (#2: lossy conversion) | 5 (#1 fragmentation, #5 any casts, #7 race, #9 non-determinism, #14 silent overwrite) | 8 | 1 |
| Simplicity | 0 | 3 (#1 naming, #2 conversion layer, #8 env incompatibility) | 3 | 2 |
| **Total** | **2** | **11** | **16** | **8** |

**Verdict**: Design revised. All 2 CRITICAL and 11 HIGH findings addressed.

### Round 2 (revised design — re-red-team)

| Lens | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Security | **0** | **0** | 1 (N-1: compile subprocess code exec) | 5 (cross-device rename, stale warning, etc.) |
| Correctness | **0** | **0** | 4 (_meta hash, concurrency falsy, stdout pollution, legacy ambiguity) | 3 |
| Simplicity | **0** | **0** | 3 (triple env fields, empty-task cache, test migration) | 3 |
| **Total** | **0** ✅ | **0** ✅ | **8** | **11** |

**Verdict**: Design PASSES. Zero CRITICAL, zero HIGH. MEDIUM findings documented as accepted risks below.

### Accepted Risks (MEDIUM findings from Round 2)

| ID | Finding | Mitigation |
|----|---------|------------|
| S-N1 | `b4mal config compile` runs .ts in subprocess with full privileges | Document: compile step executes user code; only run on trusted configs. Subprocess isolation (separate process) prevents build-tool compromise. |
| C-N1 | `_meta.configHash` verification behavior underspecified | Spec: hash post-Zod, pre-sort normalized JSON. On mismatch: warn + suggest `--sync`. Lockfile envelope: `{"version":2,"_meta":{...},"tasks":[...]}`. |
| C-N2 | `concurrency: 0` falsy in executor (`0 ?? cpus().length` → cpus) | Fix: use explicit `!== undefined` check. When 0, remove active-count gating from dispatch loop. |
| C-N3 | `config compile` stdout pollution from stray console.log | Extract JSON: find first `{` and matching last `}` in captured stdout. Document that stdout must contain only the JSON config. |
| C-N4 | Legacy field ambiguity when both old and new names present | Warn when both `deps` and `dependencies` found on same task, listing discarded values. |
| Sm-N1 | Triple env fields (`env` + `envReads` + `envWrites`) conceptual overload | Rename: `envReads` → `needsEnv`, `envWrites` → `providesEnv`. Document merge strategy (task-level overrides project-level at key granularity). |
| Sm-N2 | Empty-task cache key vulnerability (no inputs declared, cache:true) | Refine schema: require at least one `input` or `output` when `cache: true`, OR document that cache is a no-op for input-less tasks. |
| Sm-N3 | Old v1 file removal breaks 12+ test files | Add "Test Migration" section below; identify all affected tests and plan updates before v1 removal. |

---

## Revised Design

### Key Architectural Decision: Declarative JSON Format

**Original design**: `b4mal.config.ts` loaded via `import()` — executes arbitrary TypeScript in the build process.
**Verdict**: REJECTED (C-1: arbitrary code execution).
**Revised design**: `b4mal.config.json` — a declarative JSON file validated by Zod. No code execution. TypeScript authoring supported via a compile step that runs in a separate process.

Rationale:
- Turborepo and Nx both use JSON configs — this is the industry standard
- JSON cannot execute code; Zod provides the validation layer
- TypeScript type checking is available via `b4mal config check --ts` (separate process)
- The "No YAML. No DSL. Just types." philosophy is preserved via Zod schema + JSON Schema generation for IDE support

### Architecture (Revised)

```
b4mal.config.json        (user authors this — declarative JSON)
       │
       ▼
B4malConfigSchema.parse() (Zod validation at load time)
       │
       ▼
configToLockfile()        (deterministic serialization to b4mal.lock)
       │
       ▼
b4mal.lock                (generated JSON, git-committed)
       │
       ▼
B4malEngine.build()       (reads b4mal.lock — no engine changes)
```

Optional TypeScript path (separate process, explicit):
```
b4mal.config.ts           (user authors this for type checking)
       │
       ▼
b4mal config compile      (runs `bun run b4mal.config.ts` in separate process,
       │                   captures stdout JSON, validates, writes b4mal.config.json)
       ▼
b4mal.config.json         (canonical config, committed to git)
```

### Unified Type System (One Type to Rule Them All)

The core problem identified by all three reviewers: `TaskSchema`, `OrchestratorTask`, and the proposed `ConfigTask` are three structurally incompatible types. The fix: one canonical type.

```typescript
// src/schema.ts — canonical task definition (replaces TaskSchema + OrchestratorTask)

export const TaskConfigSchema = z.object({
  /** Unique task identifier */
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Task ID must be alphanumeric"),

  /** Command and arguments */
  cmd: z.array(z.string()).min(1),

  /** Task IDs that must complete before this one */
  dependencies: z.array(z.string()).default([]),

  /** Filesystem paths this task reads (relative to project root) */
  inputs: z.array(z.string()).default([])
    .transform(ps => ps.map(sanitizePath))
    .describe("Files/dirs this task reads"),

  /** Filesystem paths this task writes (relative to project root) */
  outputs: z.array(z.string()).default([])
    .transform(ps => ps.map(sanitizePath))
    .describe("Files/dirs this task writes"),

  /** Non-filesystem resource claims (e.g., "env:PORT", "db:local", "port:8080") */
  claims: z.array(z.string()).default([])
    .describe("Non-filesystem resources this task accesses"),

  /** Env vars this task depends on (names only, not values). Used for resource-claim conflict detection. */
  needsEnv: z.array(z.string()).default([]),

  /** Env vars this task provides/sets (names only, not values). Used for resource-claim conflict detection. */
  providesEnv: z.array(z.string()).default([]),

  /** Extra env vars to set for this task (values, merged onto sanitized env) */
  env: z.record(z.string()).default({}),

  /** Working directory (relative to project root, or null for project root) */
  cwd: z.string().optional()
    .refine(p => !p || (!p.startsWith("/") && !p.includes("..")),
      "cwd must be relative and within project root"),

  /** Timeout in ms (0 = use default of 30 minutes) */
  timeout: z.number().int().nonnegative().max(3_600_000).default(300_000),

  /** Allow caching (default true) */
  cache: z.boolean().default(true),
});

// Project-level config
export const B4malConfigSchema = z.object({
  /** Project name (optional, defaults to directory name) */
  name: z.string().optional(),

  /** Task definitions keyed by ID (order-independent; sorted alphabetically in lockfile) */
  tasks: z.record(TaskConfigSchema).refine(
    tasks => Object.keys(tasks).length > 0,
    "At least one task is required"
  ).refine(
    tasks => {
      // All dependency references must resolve to existing task IDs
      const ids = new Set(Object.keys(tasks));
      for (const [id, task] of Object.entries(tasks)) {
        for (const dep of task.dependencies) {
          if (!ids.has(dep)) return false;
        }
      }
      return true;
    },
    { message: "All dependency references must resolve to existing task IDs" }
  ),

  /** Max parallel tasks (0 = unbounded, up to OS limits) */
  concurrency: z.number().int().nonnegative().default(0),

  /** Base env inherited by all tasks (values) */
  env: z.record(z.string()).default({}),
});

// Helper to sanitize individual path strings
function sanitizePath(p: string): string {
  if (p.startsWith("/")) throw new Error(`Absolute paths not allowed: "${p}"`);
  if (p.includes("..")) throw new Error(`Path traversal not allowed: "${p}"`);
  // Normalize to forward slashes for cross-platform determinism
  return p.replace(/\\/g, "/");
}

export type TaskConfig = z.infer<typeof TaskConfigSchema>;
export type B4malConfig = z.infer<typeof B4malConfigSchema>;
```

### Type Unification Strategy

`OrchestratorTask` is removed. The orchestration layer imports `TaskConfig` directly from schema.ts. The lockfile format changes to match the canonical schema (one-time migration, backward compatible read):

| Old lockfile field | New lockfile field | Migration |
|---|---|---|
| `deps: string[]` | `dependencies: string[]` | Rename on read |
| `reads: string[]` | `inputs: string[]` | Rename on read |
| `writes: string[]` | `outputs: string[]` | Rename on read |
| `claims: string[]` | `claims: string[]` | Preserved (already canonical) |
| (missing) | `cwd: string?` | New field, default null |
| (missing) | `timeout: number` | New field, default 300000 |
| (missing) | `cache: boolean` | New field, default true |
| (missing from type) | `needsEnv: string[]` | Added to type (was `(t as any).envReads`) |
| (missing from type) | `providesEnv: string[]` | Added to type (was `(t as any).envWrites`) |

### Deterministic Lockfile Generation

To ensure the same config produces identical lockfiles across platforms and Node versions:

1. **Task ordering**: Tasks sorted alphabetically by `id` before serialization
2. **Array ordering**: `dependencies`, `inputs`, `outputs`, `claims`, `envReads`, `envWrites` all sorted alphabetically
3. **Record ordering**: `env` entries sorted by key
4. **Path separators**: Always `/` (never `\`), enforced by `sanitizePath()`
5. **No glob expansion**: Paths are literal strings; no filesystem-dependent expansion
6. **No filesystem access**: Lockfile generation does not read any files; it is a pure function of the config

### Atomic Lockfile Write

```typescript
// src/config/loader.ts
import { writeFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

function writeLockfileAtomic(config: B4malConfig, lockPath: string): void {
  const tasks = configToTasks(config); // pure function, deterministic
  const json = JSON.stringify(tasks, null, 2);
  const tmp = join(tmpdir(), `b4mal-lock-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(tmp, json, "utf-8");
  renameSync(tmp, lockPath); // atomic on same filesystem (POSIX guarantee)
}
```

This prevents:
- Concurrent builds seeing partially-written lockfiles
- Crash-during-write leaving corrupt lockfiles
- TOCTOU races on lockfile reading

### Config → Lockfile Flow (in CLI, not Engine)

Per simplicity review finding: the CLI handles config resolution before calling the engine. The engine only reads `b4mal.lock`.

```
b4mal build:
  1. Check for b4mal.config.json
  2. If found:
     a. Read and validate via B4malConfigSchema.parse()
     b. Check if b4mal.lock exists and is stale (config mtime > lock mtime)
     c. If stale or missing → regenerate lockfile atomically
     d. If config validation fails → hard error, no fallback to stale lockfile
  3. If only b4mal.lock exists (legacy) → proceed as before
  4. Call engine.build() — which only reads b4mal.lock
```

### Backwards Compatibility (Revised)

1. **Only `b4mal.lock` exists** (legacy) → build directly. The engine reads old field names (`deps` → `dependencies`, `reads` → `inputs`, `writes` → `outputs`)
2. **Only `b4mal.config.json` exists** → validate, generate lockfile, build
3. **Both exist, lockfile is fresh** → build from lockfile (no regeneration)
4. **Both exist, config is newer** → warn "b4mal.config.json is newer than b4mal.lock. Run b4mal build --sync to regenerate." Build from lockfile, not config (no silent overwrite). `--sync` flag explicitly regenerates.
5. **Config has validation error** → hard error, no fallback to lockfile even if lockfile exists

### Optional TypeScript Authoring

Users who want TypeScript type checking in their config:

```typescript
// b4mal.config.ts
import type { B4malConfig } from "b4mal/schema";

const config: B4malConfig = {
  tasks: {
    build: {
      cmd: ["bun", "build"],
      inputs: ["src"],
      outputs: ["dist"],
    },
  },
};

// Write to stdout so b4mal config compile can capture it
console.log(JSON.stringify(config));
```

Then: `b4mal config compile` runs `bun run b4mal.config.ts`, captures stdout, validates the JSON against `B4malConfigSchema`, and writes `b4mal.config.json`. The `.ts` file is never `import()`-ed by the build process.

### Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/schema.ts` | **Rewrite** | Canonical `TaskConfigSchema` + `B4malConfigSchema`; remove `TaskSchema`, `PipelineSchema` (unused); export `sanitizePath` |
| `src/config_loader.ts` | **New** (single file) | `loadConfig()`, `configToTasks()`, `writeLockfileAtomic()`, stale detection |
| `src/orchestrator/planner.ts` | **Modify** | Replace `OrchestratorTask` with `TaskConfig` from schema; remove mutation of input; add `envReads`/`envWrites` to planning |
| `src/core/engine.ts` | **Modify** | Remove `(t as any)` casts; use `TaskConfig` type; add `envReads`/`envWrites` to verification; add cross-wave `detectShadowing()` to `build()` |
| `src/core/formal_shadow.ts` | **Modify** | Accept `TaskConfig` instead of ad-hoc interface |
| `src/orchestrator/executor.ts` | **Modify** | Include `env` values and `cwd` in subprocess spawn; enforce `timeout`; skip cache when `cache: false` |
| `src/cli/index.ts` | **Modify** | `build` command: add config→lockfile resolution before engine call; add `config compile` subcommand; add `--sync` flag |
| `src/cli/init.ts` | **Modify** | Generate `b4mal.config.json` instead of `b4mal.lock` |
| `b4mal.lock` | **Auto-migrate** | Rename fields on next init; old format readable by engine for backwards compat |

### Removals

| File | Action | Reason |
|------|--------|--------|
| `src/orchestrator/planner.ts` `OrchestratorTask` interface | **Remove** | Replaced by `TaskConfig` from schema |
| `src/schema.ts` `TaskSchema`, `PipelineSchema`, `TaskResultSchema`, `PipelineResultSchema` | **Remove** | Superseded by `TaskConfigSchema` + `B4malConfigSchema`; results types move to executor |
| `src/config/define-config.ts` | **Never create** | `defineConfig()` eliminated per simplicity review |
| `src/config/` directory | **Never create** | Single file `src/config_loader.ts` per simplicity review |
| `src/engine.ts` (old v1 engine) | **Remove** | Dead code; superseded by `src/core/engine.ts` |
| `src/runner.ts` (old v1 runner) | **Remove** | Dead code; superseded by `src/orchestrator/executor.ts` |
| `src/dag.ts` (old DAG) | **Remove** | Dead code; superseded by `WavePlanner` |
| `src/cli.ts` (old CLI) | **Remove** | Dead code; superseded by `src/cli/index.ts` |

### Security Hardening (from red team findings)

Following changes included in this feature scope:

1. **Path sanitization in schema** (M-4, H-1): `sanitizePath()` rejects `/` prefix, `..` segments, normalizes backslashes. Applied via Zod `.transform()` on `inputs`, `outputs`, and `cwd`.
2. **ArtifactVault.unpack() path traversal** (H-1): Add `--no-absolute-filenames` and `--no-unpack` checks to tar invocation. Verify all extracted paths resolve within projectRoot.
3. **Config symlink protection** (M-5): Resolve `b4mal.config.json` realpath before reading; reject if outside projectRoot.
4. **Cache key includes env** (Correctness #13): Include `env` values (sorted) in cache key hash computation.
5. **Lockfile integrity checksum** (L-2): Include `_meta.configHash` in lockfile with SHA-256 of the generating config. Verify match on load.

### Edge Cases (Revised)

1. **Circular dependencies** — Detected by `WavePlanner.planDAG()` during build (not at Zod level, since synthetic deps from resource overlap can create cycles post-validation). Placed after lockfile generation, before execution.
2. **Missing task references** — Caught by Zod `.refine()` at config validation time.
3. **Path traversal** — Caught by `sanitizePath()` at Zod parse time. Absolute paths, `..` segments, and backslash escapes all rejected.
4. **Empty tasks** — `z.record(TaskConfigSchema).refine(tasks => Object.keys(tasks).length > 0)`.
5. **Concurrent builds** — Atomic lockfile write eliminates partial reads. Stale detection prevents racing on lockfile regeneration. SQLite WAL mode handles concurrent cache access.
6. **Determinism** — Canonical sort order (alphabetical by ID, then by array elements), forward-slash paths, no filesystem access during generation.
7. **Silent lockfile overwrite** — Replaced with explicit `--sync` flag. Config is never silently promoted over hand-edited lockfile.
8. **Cross-wave shadowing** — Added `detectShadowing()` call to `build()` method (previously only in `b4mal shadow` command).
9. **Config validation errors** — Hard error with file path, line context, and field name. No fallback to stale lockfile.
10. **Legacy field migration** — Engine reads both old names (`deps`/`reads`/`writes`) and new names (`dependencies`/`inputs`/`outputs`), preferring new names. Old lockfiles work without modification.

### Test Migration Plan

Before removing v1 modules (`src/engine.ts`, `src/runner.ts`, `src/dag.ts`, `src/cli.ts`, `TaskSchema`/`PipelineSchema` from `src/schema.ts`), update affected tests:

| Test File | Imported From | Action |
|-----------|--------------|--------|
| `tests/engine.test.ts` | `src/engine` → `Engine` | Rewrite to test `B4malEngine` from `src/core/engine` |
| `tests/runner.test.ts` | `src/runner` → `runTask` | Rewrite to test `DynamicExecutor` from `src/orchestrator/executor` |
| `tests/dag.test.ts` | `src/dag` → `buildDag`, `formatDagPlan` | Rewrite to test `WavePlanner.planDAG()` from `src/orchestrator/planner` |
| `tests/continuous_flow.test.ts` | `src/engine` → `Engine` | Rewrite to test `B4malEngine` |
| `tests/schema.test.ts` | `src/schema` → `TaskSchema`, `PipelineSchema` | Rewrite to test `TaskConfigSchema`, `B4malConfigSchema` |
| `tests/discovery_engine.test.ts` | `src/engine` types | Update to new `TaskConfig` type |
| `.b4mal/shadow/test/tests/*` | Shadow copies | Regenerate after test rewrites |
| `.b4mal/shadow/typecheck/tests/*` | Shadow copies | Regenerate after test rewrites |

Order: write new tests → rewrite affected tests → remove v1 modules → regenerate shadows.

### Non-Goals (unchanged)

- Matrix builds, conditional execution, secrets — separate features
- Hot reloading / watch mode — separate feature
- IDE extension — LSP covers this (separate feature)
- Glob expansion in config — deferred until needed
