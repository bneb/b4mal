# Plugin Development

B4mal supports WebAssembly plugins for extending build pipelines with custom behavior.

## Plugin Types

| Hook | When | Signature |
|------|------|-----------|
| `preBuild` | Before the DAG executes | `(config: PipelineConfig) => PipelineConfig` |
| `postTask` | After each task completes | `(result: TaskResult) => TaskResult` |
| `onCacheHit` | When a cache hit occurs | `(taskId: string, hash: string) => void` |
| `onError` | When a task fails | `(taskId: string, error: string) => void` |

## Creating a Plugin

### 1. Write the plugin

```typescript
// my-plugin.ts — compiled to WASM via AssemblyScript or similar
export function postTask(result: TaskResult): TaskResult {
  // Example: send Slack notification on failure
  if (result.exitCode !== 0) {
    // Call external notification service
  }
  return result;
}
```

### 2. Install

```bash
b4mal plugin install https://plugins.b4mal.dev/my-plugin.wasm
```

### 3. Use

Plugins execute automatically when installed. No configuration needed.

## First-Party Plugins

| Plugin | Purpose |
|--------|---------|
| `slack-notifier` | Post build status to Slack |
| `bundle-size` | Track and compare bundle sizes |
| `license-check` | Validate dependency licenses |
| `vuln-scan` | Run vulnerability scan on outputs |

## Security

- Plugins run in an isolated WebAssembly sandbox
- No filesystem or network access by default
- 5-second execution timeout
- Plugin code is verified against a registry manifest
