# Orchestrator

The Orchestrator is responsible for dynamic scheduling and execution. It transforms a list of declared tasks and resource claims into a strictly ordered, maximally concurrent Directed Acyclic Graph (DAG).

## Components

### Wave Planner (`planner.ts`)
The `WavePlanner` sorts tasks into execution "waves" based on formal topological sorting (`O(V + E)`).
It performs greedy graph coloring to partition disjoint task sub-groups, injecting synthetic dependency edges (`claimsOverlap`) where parallel tasks assert conflicting filesystem read/write bounds. 

Concurrency paths are validated using case-insensitive mapping on Windows (`win32`) and macOS (`darwin`), preventing subtle APFS/NTFS concurrency collisions.

### Dynamic Executor (`executor.ts`)
The executor spawns isolated subprocesses with a sanitized environment (POSIX whitelist plus explicitly declared variables only). Scheduling is fail-fast: when a task exits non-zero, its transitive dependents are marked skipped rather than dispatched, so downstream work never runs against inputs that were never produced. Independent tasks are unaffected and still complete.

> **Note:** there is no `.b4mal/shadow` clone-on-failure workspace. A failing task leaves its partial writes in place; only its dependents are skipped.
