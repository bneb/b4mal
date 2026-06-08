# Design: Autonomous Dependency Synthesis (Trace-Based)

## Objective
Implement a new operational mode for `b4mal` that passively traces a legacy build execution (e.g., `make all` or `npm run build`), records process executions and file operations (read/write), and automatically synthesizes a mathematically sound `b4mal.lock` directed acyclic graph (DAG). This completely removes the manual burden of defining tasks, inputs, and outputs.

## Architecture

The system is decomposed into three isolated pipelines:
1.  **Tracer (Subprocess Monitor)**
2.  **Event Aggregator**
3.  **Graph Synthesizer**

### 1. Tracer (Subprocess Monitor)
Since `b4mal` operates cross-platform but the prompt dictates "eBPF Dependency Synthesis", we will implement an interface `ISystemTracer` with an `EbpfTracer` implementation (targeting Linux). Since we develop on macOS, we will also implement a `DtraceTracer` or use standard `strace` for testing parity.
*   **Input**: A raw shell command (e.g., `npm run build`).
*   **Execution**: Spawns the command wrapped in a system tracer.
*   **Output Stream**: Emits `TraceEvent` records in real-time.
    *   `ProcessSpawn`: `{ pid, ppid, cmd_array }`
    *   `FileRead`: `{ pid, filepath }`
    *   `FileWrite`: `{ pid, filepath }`

### 2. Event Aggregator
Consumes the real-time stream of `TraceEvent` objects.
*   Maintains a map of `PID -> TaskNode`.
*   As a process opens files, records the absolute path in the process's `read_claims` or `write_claims` sets.
*   Filters out noise: `/tmp/`, `/dev/`, `.git/`, standard system libraries (`/usr/lib/`), etc. Focuses strictly on workspace-relative paths.

### 3. Graph Synthesizer
Post-processes the `TaskNode` map into a `b4mal.lock` compatible graph.
*   **Dependency Resolution**: For every task $B$, if $B$ reads a file that task $A$ wrote (and $A$ ran before $B$), $B$ implicitly depends on $A$.
*   **Pruning**: Collapses intermediate wrapper scripts (e.g., `sh -c` -> `npm` -> `tsc`) into the most relevant semantic command.
*   **Output**: Generates a valid `DAGPlan` and writes it to `b4mal.lock`.

## CLI Integration
Command: `b4mal trace "<command>"`
*   Executes the command.
*   Displays a TUI HUD of synthesized tasks.
*   Emits `b4mal.lock`.

## Red-Team Vulnerability Areas (Self-Correction Criteria)
*   **Missing Intermediate Files**: If a file is memory-mapped or piped, does it bypass the trace? (We must trace `openat`, `execve`).
*   **Over-claiming**: A process reads an entire directory (e.g., `tsc` scanning `node_modules`). This would create massive unmanageable read claims. We need heuristic grouping (collapsing `src/foo.ts`, `src/bar.ts` into a prefix tree claim `src/`).
*   **Cross-Platform Fidelity**: We must fail gracefully or fallback to an alternative tracer if eBPF is unavailable.

## Next Step
Proceed to Red-Team Review of this design.
