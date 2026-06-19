# Design: --dry-run and --strict flags (Deliverables 6, 9)

## Problem
No way to preview a build plan without executing. No way to enforce collision-free builds.

## Solution
- `--dry-run`: Engine.plan() reads lockfile, plans DAG, runs collision verification, returns plan without executing. CLI prints waves, tasks, and conflicts.
- `--strict`: If collisions detected, fail the build instead of warning.

## Architecture
- PlanResult type in engine.ts with waves, totalTasks, conflicts
- Engine.plan() mirrors build()'s read-plan-verify path but returns instead of executing
- build() checks this.options.strict before returning on collision

## Files
- src/cli/index.ts — flag parsing and --dry-run output
- src/core/engine.ts — PlanResult, plan(), strict mode in build()
