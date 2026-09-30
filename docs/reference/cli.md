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
b4mal migrate ./mint.yml
```

Takes a **path**, not stdin, and writes `<pipeline-name>.ts` into the current
directory (falling back to `pipeline.ts` when the pipeline is unnamed). This page
previously showed `b4mal migrate < input.yaml > output.ts`, which the command has
never supported — it reads no stdin and prints the result to no stdout.

## `b4mal attest`

Declare the resources a task will touch and get back a normalized claim as JSON.
Intended for build scripts and other tooling — `crates/b4mal` calls it — rather
than for interactive use.

```bash
b4mal attest build fs:read:src fs:write:dist env:NODE_ENV port:8080
```

```json
{
  "accepted": true,
  "taskName": "build",
  "caller": { "name": "unknown", "version": "unknown" },
  "claim": {
    "id": "build",
    "reads": ["src"],
    "writes": ["dist", "port:8080"],
    "envReads": ["NODE_ENV"],
    "envWrites": []
  }
}
```

Claim prefixes: `fs:<path>` (read), `fs:read:<path>`, `fs:write:<path>`,
`env:<var>` (read), `env:read:<var>`, `env:write:<var>`, `port:<n>` (treated as an
exclusive write). Exits `0` when the declaration is accepted and `1` with an
`error` field when it is not — for example a missing task name.

Set `B4MAL_CALLER` to identify the calling shim (e.g. `rust-shim-v1.0.0`) and it is
echoed back in `caller`.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `B4MAL_DB_PATH` | Override SQLite ledger path |
| `B4MAL_CACHE_SECRET` | HMAC key for remote artifact signing. Set it and pushes are signed and pulls verified; unset means the remote cache is unauthenticated. See [Caching](/concepts/caching). |
| `AWS_ACCESS_KEY_ID` | S3 access key for L2 cache |
| `AWS_SECRET_ACCESS_KEY` | S3 secret key for L2 cache |
| `AWS_REGION` | S3 region |
| `B4MAL_CACHE_BUCKET` | S3 bucket for L2 cache |
| `AWS_S3_ENDPOINT` | Custom S3 endpoint (R2, MinIO, B2) |
| `B4MAL_CACHE_ORG` | Org prefix for multi-tenant L2 cache |
| `B4MAL_CALLER` | Caller identity reported by `b4mal attest` |

`B4MAL_STRICT_SANDBOX` was listed here previously as "Enable OS-level sandboxing".
It is not read by any code — setting it has no effect. Sandboxing is not
implemented; see the [security model](/concepts/security-model).
