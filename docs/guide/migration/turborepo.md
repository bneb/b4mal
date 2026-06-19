# Migrating from Turborepo

B4mal can auto-detect your `turbo.json` and convert it. This guide covers the manual migration for teams that want to understand the mapping.

## Quick Migration

```bash
cd your-turborepo-project
b4mal init
```

B4mal detects `turbo.json` and offers to migrate automatically. If you accept, it writes `b4mal.config.json` and `b4mal.lock`.

## Manual Mapping

### Pipeline → Tasks

A Turborepo pipeline entry maps to a B4mal task:

**turbo.json:**
```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    }
  }
}
```

**b4mal.config.json:**
```json
{
  "tasks": {
    "build": {
      "cmd": ["echo", "No package.json script found for 'build'. Define its command in b4mal.config.json."],
      "outputs": ["dist"],
      "dependencies": []
    }
  }
}
```

### Key Differences

| Turborepo | B4mal |
|-----------|-------|
| `dependsOn: ["^build"]` (topological) | `dependencies: ["build"]` (explicit task IDs) |
| `outputs: ["dist/**"]` (glob) | `outputs: ["dist"]` (directory, no glob expansion) |
| Implicit dependency inference | Explicit resource claims required |
| `cache: true/false` per task | `cache: true/false` per task (same) |
| `inputs` for cache key scoping | `inputs` declares read paths for collision detection AND cache key |
| No collision detection | Prefix-tree verifies no concurrent writes overlap |

### What B4mal Catches That Turborepo Doesn't

In Turborepo, if two tasks both write to `dist/shared/` and run in parallel, the result depends on execution order. Turborepo trusts your dependency graph. B4mal detects this at plan time and either serializes the tasks or reports the collision.

```json
{
  "tasks": {
    "compile-a": {
      "cmd": ["tsc", "-p", "packages/a"],
      "outputs": ["packages/a/dist"]
    },
    "compile-b": {
      "cmd": ["tsc", "-p", "packages/b"],
      "outputs": ["packages/b/dist"]
    }
  }
}
```

These run in parallel safely — different output directories.

```json
{
  "tasks": {
    "compile-a": {
      "cmd": ["tsc", "-p", "packages/a"],
      "outputs": ["dist/shared"]
    },
    "compile-b": {
      "cmd": ["tsc", "-p", "packages/b"],
      "outputs": ["dist/shared"]
    }
  }
}
```

B4mal detects this collision. Turborepo would run both in parallel and silently corrupt the output.
