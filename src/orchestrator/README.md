# Orchestrator

The Orchestrator is responsible for dynamic scheduling and execution. It transforms a list of declared tasks and resource claims into a strictly ordered, maximally concurrent Directed Acyclic Graph (DAG).

## Components

### Wave Planner (`planner.ts`)
The `WavePlanner` sorts tasks into execution "waves" based on formal topological sorting (`O(V + E)`).
It performs greedy graph coloring to partition disjoint task sub-groups, injecting synthetic dependency edges (`claimsOverlap`) where parallel tasks assert conflicting filesystem read/write bounds. 

Concurrency paths are validated using case-insensitive mapping on Windows (`win32`) and macOS (`darwin`), preventing subtle APFS/NTFS concurrency collisions.

### Dynamic Executor (`executor.ts`)
The executor spawns isolated subprocesses. Tasks that fail execution are snapshotted into the `.b4mal/shadow` diagnostic sandbox, permitting inspection without dirtying the current workspace.
