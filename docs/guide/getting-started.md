# Getting Started

B4mal is a deterministic build orchestrator for monorepos. It guarantees reproducibility through formal resource verification and AST-normalized caching.

## Prerequisites

- **Bun** v1.2+ ([install](https://bun.sh))
- A monorepo project (or any project with multiple build steps)

## Quick Start

### 1. Install

```bash
curl -fsSL https://b4mal.dev/install.sh | bash
```

Or via Bun:

```bash
bun install -g b4mal
```

### 2. Initialize

```bash
cd your-project
b4mal init
```

B4mal auto-detects your project structure. If you have existing Turborepo, Nx, or Lerna configuration, it offers to migrate automatically.

### 3. Configure

`b4mal init` writes a `b4mal.config.json` file. Edit it to define your build tasks:

```json
{
  "tasks": {
    "typecheck": {
      "cmd": ["bunx", "tsc", "--noEmit"],
      "inputs": ["src"]
    },
    "test": {
      "cmd": ["bun", "test"],
      "inputs": ["src", "tests"],
      "dependencies": ["typecheck"]
    },
    "build": {
      "cmd": ["bun", "build", "src/index.ts", "--outdir", "dist"],
      "inputs": ["src"],
      "outputs": ["dist"],
      "dependencies": ["typecheck", "test"]
    }
  }
}
```

### 4. Build

```bash
b4mal build
```

B4mal plans the DAG, verifies resource isolation, and executes tasks in parallel where safe.

### 5. Analyze

```bash
b4mal analyze
```

Opens an interactive dashboard showing task timing, cache hit rates, and the dependency graph.

## What's Happening

1. **Discovery** — B4mal scans your project structure and configuration.
2. **Planning** — Tasks are assembled into a DAG and grouped into parallel execution waves.
3. **Verification** — A prefix tree checks for resource collisions between concurrent tasks. Conflicting tasks are serialized automatically.
4. **Execution** — Tasks run with sanitized environments. Output is cached for future builds.
5. **Reporting** — Cache statistics, timing data, and bottleneck analysis are displayed.

## Next Steps

- [Configuration reference](/guide/configuration) — all task fields explained
- [Migration from Turborepo](/guide/migration/turborepo)
- [Understanding resource isolation](/concepts/resource-isolation)
- [CLI command reference](/reference/cli)
