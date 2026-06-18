# Configuration Reference

`b4mal.config.json` is the declarative configuration file for B4mal. It defines your project's build tasks, their dependencies, and resource declarations.

## Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tasks` | `Record<string, TaskConfig>` | Yes | — | Task definitions keyed by ID |
| `name` | `string` | No | directory name | Project name for display |
| `concurrency` | `number` | No | `0` | Max parallel tasks (`0` = unbounded) |
| `env` | `Record<string, string>` | No | `{}` | Base environment inherited by all tasks |

## Task Fields

### Required

| Field | Type | Description |
|-------|------|-------------|
| `cmd` | `string[]` | Command and arguments. Example: `["bun", "build", "--outdir", "dist"]` |

### Dependencies

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dependencies` | `string[]` | `[]` | Task IDs that must complete before this task starts |

### Resource Declarations

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `inputs` | `string[]` | `[]` | Filesystem paths this task reads (relative to project root) |
| `outputs` | `string[]` | `[]` | Filesystem paths this task writes (relative to project root) |
| `claims` | `string[]` | `[]` | Non-filesystem resources: `"env:VAR"`, `"db:name"`, `"port:8080"` |
| `needsEnv` | `string[]` | `[]` | Env var names this task reads (for conflict detection) |
| `providesEnv` | `string[]` | `[]` | Env var names this task sets (for conflict detection) |

### Execution

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `env` | `Record<string, string>` | `{}` | Extra env vars injected into this task |
| `cwd` | `string` | — | Working directory relative to project root |
| `timeout` | `number` | `300000` | Timeout in ms (`0` = 5 min default, max 60 min) |
| `cache` | `boolean` | `true` | Whether to cache this task's output |

## Resource Declarations

### Why declare resources?

B4mal uses resource declarations to detect conflicts between concurrent tasks. If two tasks both write to `dist/`, B4mal serializes them — even if you forgot to add a dependency edge. This prevents silent race conditions.

### Path format

All paths are relative to the project root. Forward slashes only (backslashes are normalized). Path traversal (`..`) and absolute paths are rejected.

```json
{
  "inputs": ["src", "packages/frontend/dist"],
  "outputs": ["dist", "coverage"]
}
```

### Non-filesystem claims

Use the `claims` field for resources that aren't files:

```json
{
  "claims": ["env:PORT", "db:primary", "port:8080"]
}
```

If two tasks claim the same non-filesystem resource, B4mal serializes them.

## Examples

### Minimal

```json
{
  "tasks": {
    "build": { "cmd": ["bun", "build", "src/index.ts"] }
  }
}
```

### Multi-step pipeline

```json
{
  "tasks": {
    "lint": {
      "cmd": ["eslint", "src/"],
      "inputs": ["src"]
    },
    "typecheck": {
      "cmd": ["tsc", "--noEmit"],
      "inputs": ["src"]
    },
    "test": {
      "cmd": ["bun", "test"],
      "inputs": ["src", "tests"],
      "dependencies": ["typecheck"]
    },
    "build": {
      "cmd": ["bun", "build"],
      "inputs": ["src"],
      "outputs": ["dist"],
      "dependencies": ["lint", "typecheck", "test"]
    }
  },
  "concurrency": 4
}
```

### With database claim (serialization)

```json
{
  "tasks": {
    "migrate": {
      "cmd": ["bun", "run", "db/migrate.ts"],
      "claims": ["db:primary"],
      "needsEnv": ["DATABASE_URL"]
    },
    "seed": {
      "cmd": ["bun", "run", "db/seed.ts"],
      "claims": ["db:primary"],
      "needsEnv": ["DATABASE_URL"],
      "dependencies": ["migrate"]
    }
  }
}
```

### Disable caching for a task

```json
{
  "tasks": {
    "deploy": {
      "cmd": ["bun", "run", "deploy.ts"],
      "inputs": ["dist"],
      "cache": false
    }
  }
}
```

### Conditional execution

Use `when` to skip tasks based on platform or branch:

```json
{
  "tasks": {
    "deploy": {
      "cmd": ["bun", "run", "deploy.ts"],
      "inputs": ["dist"],
      "when": {
        "branch": "main",
        "platform": ["linux"]
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `when.branch` | `string` | Glob pattern for branch name (e.g. `"main"`, `"release-*"`) |
| `when.platform` | `string[]` | OS platforms to run on (`"darwin"`, `"linux"`, `"win32"`) |
| `when.if` | `string` | Arbitrary condition expression (reserved for future use) |

### Matrix builds

Use `matrix` to generate task instances from axis values:

```json
{
  "tasks": {
    "build": {
      "cmd": ["bun", "build", "--target", "$MATRIX_OS"],
      "inputs": ["src"],
      "outputs": ["dist"],
      "matrix": {
        "os": ["linux", "macos"],
        "arch": ["x64", "arm64"]
      }
    }
  }
}
```

This generates four tasks: `build-os=linux-arch=x64`, `build-os=linux-arch=arm64`, `build-os=macos-arch=x64`, and `build-os=macos-arch=arm64`. Axis values are injected as `MATRIX_<AXIS>` env vars (e.g., `MATRIX_OS=linux`).

**Limits**: Max 4 axes, 10 values per axis, 256 total combinations.
