# Security Model

B4mal's cache and execution infrastructure is designed under the assumption that build artifacts are **adversarial** — a compromised cache entry should never be able to escape the sandbox, overwrite source files, or poison downstream builds.

## Threat model

B4mal defends against:

- **Cache poisoning** — an attacker with write access to the S3 bucket injects a malicious artifact
- **TOCTOU (time-of-check/time-of-use)** — a local process swaps a file between verification and extraction
- **Symlink breakout** — a crafted tar archive containing symlinks that escape the project root
- **Path traversal** — archive entries like `../../.ssh/authorized_keys`
- **Resource collision** — two concurrent tasks silently overwriting each other's outputs

B4mal does NOT defend against:

- Compromised build machines (root access defeats all userspace protections)
- Malicious task commands (B4mal executes what you declare — it doesn't sandbox process behavior)
- Side-channel attacks (cache timing, power analysis)

## Artifact vault hardening

### Pack (creating archives)

When packing task outputs into the artifact vault:

1. **O_NOFOLLOW** — every output file is opened with `O_NOFOLLOW`, which fails if the path is a symlink. This prevents following symlinks to files outside the declared output set.
2. **Inode/device verification** — after opening, `fstat()` is called and the inode + device pair is compared against the `lstat()` values taken before opening. If they differ, a TOCTOU swap occurred and the pack is aborted.
3. **Canonical path boundaries** — every path is resolved with `realpath()` and verified to be within the project root. On macOS, this handles `/tmp` → `/private/tmp` symlink normalization.
4. **Secure staging** — files are copied into a temporary staging directory before archiving. The staging directory is created with `mkdtemp()` and never contains symlinks.

### Unpack (extracting archives)

When restoring artifacts from the vault:

1. **List-before-extract** — `tar -t` lists all entries. Each entry is validated:
   - Must not start with `/` (absolute path)
   - Must not contain `..` (parent traversal)
   - Must resolve to within the project root when joined with `realpath(root)`
2. **Two-stage extraction** — if the listing passes validation, a second `tar -xf` extracts the contents. The listing and extraction are separate processes, preventing TOCTOU between verification and extraction.
3. **No symlink preservation** — extracted files are regular files only. The archive format does not support symlinks or device nodes.

## Cache key integrity

Cache keys are SHA-256 hashes computed from:

- The task command and arguments (canonicalized)
- The exact contents of all declared input files
- The values of all declared environment variables
- The task's resource claims (filesystem and environment)

Secret values (declared via `secrets: [...]`) are injected at runtime but **never included in the cache key**. This prevents secrets from being hashed and logged, while still allowing secret-dependent tasks to execute correctly (they always miss the cache).

## Isolation attestations

After verifying a wave of concurrent tasks, B4mal generates a signed attestation:

```json
{
  "verifier": "b4mal-formal-shadow",
  "wave": ["task-a", "task-b"],
  "result": "isolated",
  "logicHash": "sha256:...",
  "resourceSetHash": "sha256:..."
}
```

This attestation cryptographically proves that the task set was verified conflict-free at the time of execution. In regulated environments, attestations provide an audit trail for build correctness.

## Environment sanitization

The `EnvSanitizer` filters the environment passed to each task:

- Only explicitly declared `needsEnv` variables are forwarded
- `providesEnv` variables from upstream tasks are injected into downstream tasks
- All other environment variables are stripped before the child process is spawned
- Secrets are injected from the host environment at spawn time, never stored or hashed

This prevents implicit environment dependencies — a task can't accidentally depend on `$HOME` or `$USER` unless it declares them.

## Recommendations for production

1. **Use a dedicated S3 bucket** with object versioning enabled and write-once-read-many policies
2. **Rotate AWS credentials** used for the L2 cache regularly
3. **Enable S3 access logging** to detect cache poisoning attempts
4. **Pin B4mal versions** in CI — `npm i -g b4mal@0.1.0` rather than `@latest`
5. **Run `b4mal shadow`** in CI to detect deterministic overwrites before they reach production
6. **Archive isolation attestations** alongside build logs for compliance audits
