# Installation

The CLI is a Bun script, so **Bun must be installed** whichever method you use.

## macOS & Linux

```bash
bun install -g @bneb/b4mal
```

Or via the install script, which falls back to npm when no prebuilt binary matches
your platform:

```bash
curl -fsSL https://raw.githubusercontent.com/bneb/b4mal/main/install.sh | sh
```

`npm install -g @bneb/b4mal` also places the `b4mal` binary on your `PATH`, but it
does not supply a runtime — Bun still has to be installed.

## Windows

```bash
bun install -g @bneb/b4mal
```

**Smoke-tested, with caveats.** A `windows-latest` CI job runs `scripts/smoke-windows.ts`,
which exercises `--version`, `--help`, `attest`, a two-task build with a declared
dependency, and `check`, using only `bun -e` for task commands. All of that passes on
Windows.

What that does not cover: the test suite itself (it uses `sh -c` throughout, so it
cannot run there), and L1 caching. The artifact vault shells out to `tar` and `zstd`;
Windows ships the former but not the latter, so packing fails and each run re-executes
rather than restoring from cache. No prebuilt Windows binary is published either — the
release matrix builds Linux and macOS only.

## Docker

```bash
docker run --rm -v "$(pwd):/workspace" -w /workspace oven/bun:1 bun x @bneb/b4mal build
```

The unscoped name `b4mal` is not publishable (npm's typosquat guard rejects it as too
similar to an existing package), so `bun x b4mal` and `npx b4mal` will not resolve —
use `@bneb/b4mal`.

## Platform Notes

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Build execution | ✅ tested | ✅ tested (CI) | ✅ smoke-tested (CI) |
| Cache (L1) | ✅ | ✅ | ❌ needs `zstd` |
| Remote cache (L2) | ⚠️ verified against a stub only | ⚠️ verified against a stub only | ⚠️ same |
| Trace synthesis | ❌ (SIP) | ✅ (strace/eBPF) | ❌ |

There is no failure sandbox on any platform — failed tasks leave their partial writes
in place and only their dependents are skipped. See the
[security model](/concepts/security-model).

**Trace synthesis** is Linux-only. On macOS and Windows it cannot run natively; use a
Linux container with `--cap-add=SYS_PTRACE` if you need it.
