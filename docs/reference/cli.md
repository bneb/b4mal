# CLI Commands

## `b4mal init`

Initialize B4mal in your project. Auto-detects Turborepo, Nx, and Lerna configurations.

```bash
b4mal init
```

Options:
- `--from-config` — Generate lockfile from existing `b4mal.config.json`

## `b4mal build`

Execute the build pipeline.

```bash
b4mal build [options]
```

Options:
| Flag | Description |
|------|-------------|
| `--force` | Ignore cache, rebuild everything |
| `--debug` | Print stack traces on error |
| `--chaos` | Randomize execution order (finds hidden dependencies) |
| `--concurrency N` | Max parallel tasks |
| `--sync` | Regenerate lockfile from config before building |

## `b4mal trace`

Synthesize a B4mal pipeline by tracing a legacy build command.

```bash
b4mal trace "npm run build"
```

Platform support:
| OS | Method |
|----|--------|
| Linux | eBPF / strace (native) |
| macOS | Requires Docker (`--cap-add=SYS_PTRACE`) |
| Windows | Requires Docker |

## `b4mal analyze`

Generate an interactive HTML dashboard for build analysis.

```bash
b4mal analyze
```

Opens `b4mal-report.html` with DAG visualization, task timing, and cache statistics.

## `b4mal shadow`

Audit the DAG for deterministic overwrite patterns (shadowing).

```bash
b4mal shadow
```

## `b4mal clean`

Purge all local cache entries and ledger records.

```bash
b4mal clean
```

## `b4mal lsp`

Start the Language Server Protocol server for editor integration.

```bash
b4mal lsp
```

Provides real-time collision diagnostics in your editor when editing `b4mal.config.json`.

### VS Code

Install the B4mal extension:

```bash
cd vscode-extension && npm install && npx vsce package
code --install-extension b4mal-0.1.0.vsix
```

Or use the LSP directly by adding to `settings.json`:

```json
{
  "b4mal.lsp.path": "/path/to/b4mal"
}
```

## `b4mal remote status`

Check remote cache (L2) connectivity and statistics.

```bash
b4mal remote status
```

## `b4mal setup ci`

Generate CI configuration.

```bash
b4mal setup ci --target github
```

Currently supports `--target github` (GitHub Actions).

## `b4mal migrate`

Transpile a legacy Mint/RWX YAML pipeline to B4mal format.

```bash
b4mal migrate < input.yaml > output.ts
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `B4MAL_DB_PATH` | Override SQLite ledger path |
| `B4MAL_CACHE_SECRET` | HMAC key for artifact signing |
| `B4MAL_STRICT_SANDBOX` | Enable OS-level sandboxing |
| `AWS_ACCESS_KEY_ID` | S3 access key for L2 cache |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key for L2 cache |
| `AWS_REGION` | S3 region |
| `B4MAL_CACHE_BUCKET` | S3 bucket for L2 cache |
| `AWS_S3_ENDPOINT` | Custom S3 endpoint (R2, MinIO, B2) |
| `B4MAL_CACHE_ORG` | Org prefix for multi-tenant L2 cache |
