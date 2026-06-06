/**
 * B4mal v2.6.0 — Core Manual
 *
 * Integrated CLI documentation for interpreting Z3 proofs,
 * optimizing heatmap concurrency, and understanding the
 * Core Shield system.
 */

export const CoreManual = {
    version: "2.6.0",
    content: `
# B4MAL CORE MANUAL v2.6.0

## The Resource Heatmap

The Heatmap provides a real-time "Weather Map" of your monorepo during
concurrent task execution. Each zone represents a directory namespace.

### Zone States

  [ R ]  Read-Only. Tasks are reading from this zone. Safe for massive
         parallelism — no isolation risk.

  [ W ]  Active Write. A single task is writing to this zone. Monitored
         by the Resource Monitor engine.

  [!!]   Contention Detected. Multiple tasks are writing to the same zone
         and Z3 has not yet proven isolation. Investigate immediately.

  []  Formally Verified. The Z3 solver has produced an UNSAT proof
         confirming zero collision risk for this zone. Maximum trust.

  [   ]  Empty. No active tasks in this namespace.

### State Precedence

  SHIELD > CONTENTION > WRITE > READ > EMPTY

  Once Z3 returns UNSAT, any CONTENTION or WRITE state is promoted to
  SHIELD. This is the "Core Guarantee."

## Deterministic Shadowing

While b4mal prevents non-deterministic race conditions during parallel execution,
DAGs can still suffer from logical inefficiencies. "Shadowing" occurs when a
downstream task deterministically overwrites the exact output of an upstream task.

Use \`b4mal shadow\` to mathematically prove if any task in your dependency chain
is masking the output of its prerequisites. This ensures every write in your build
is additive or uniquely required.

## Remote Execution & VM Isolation

b4mal is designed to orchestrate complex multi-VM environments. When integrated
with providers like RWX, b4mal switches from shared-state isolation to the
\`VM_PER_TASK\` strategy.

In this mode, b4mal acts as a semantic orchestrator:
  1. It proves the OverlayFS merge integrity via Z3 before dispatching.
  2. It calculates the optimal layer merge order based on dependency depth.
  3. It guarantees that the final aggregated artifact is deterministic and sound.

## Optimizing concurrency

1. **Reduce Contention**: If you see [!!] red zones, your tasks are
   competing for the same files. Use \`b4mal audit --git\` to verify
   if the collision is logical or just aesthetic (comment/type changes).

2. **Maximize Waves**: Restructure your DAG so that tasks in the same
   wave write to different zones. The heatmap will confirm isolation.

3. **Environment Isolation**: Use task-specific env prefixes (e.g.,
   TASK_BUILD_PORT, TASK_TEST_PORT) to avoid env/ zone contention.

## The Shield HUD

The Shield HUD renders the full proof tree for each task:

  SHIELD VERIFIED: build
   ├─┬─ ISOLATION PROOF [UNSAT]
   │ ├── dist/bundle.js  (fs)  [OK] DISJOINT
   │ └── env:NODE_ENV    (env) [OK] DISJOINT
   └── Solver: set-theoretic v1.0.0

## Commands

  b4mal init          Bootstrap environment (certs, state, forecast)
  b4mal build         Prove and execute the pipeline
  b4mal shadow        Audit DAG for deterministic output masking
  b4mal migrate       Transpile RWX Mint YAML to b4mal
  b4mal audit         30-day telemetry summary
  b4mal pitch         Generate Technical Appendix for investors
  b4mal manual        Display this manual
`.trim(),
};
