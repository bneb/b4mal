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

## GitHub Action

Add a build-graph audit to any repository — it reads your `b4mal.config.json` (or
`b4mal.lock`) and reports problems as inline PR annotations. It does not run a
build, and a repository without b4mal files is a no-op, so it's safe to add
anywhere.

```yaml
# .github/workflows/b4mal.yml
name: b4mal
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: bneb/b4mal@v0.1.2
        with:
          fail-on-findings: false   # report first; gate when you are ready
```

It finds three kinds of issue, the same ones `b4mal check` reports: resource
collisions, deterministic overwrites (a task silently clobbers another), and
implicit dependencies (a task reads another's output with no edge declared).

Inputs: `version` (pin for reproducible CI), `project-path`, and
`fail-on-findings` (default `true`; set `false` to adopt gradually). Outputs:
`verified`, `findings`, `collisions`, `shadows`, `implicit`.

If you don't have a config yet, `b4mal init` writes one from your existing
`turbo.json`, `nx.json`, `lerna.json`, or `package.json` scripts.
