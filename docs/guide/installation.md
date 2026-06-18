# Installation

## macOS & Linux

```bash
curl -fsSL https://b4mal.dev/install.sh | bash
```

Or via Bun:

```bash
bun install -g b4mal
```

## Windows

### Via Bun (recommended)

```bash
bun install -g b4mal
```

### Via Scoop

```powershell
scoop bucket add b4mal https://github.com/b4mal/scoop-bucket
scoop install b4mal
```

### Manual

Download the latest `b4mal.exe` from [GitHub Releases](https://github.com/b4mal/b4mal/releases) and place it in your `PATH`.

## Docker

```bash
docker run -v $(pwd):/workspace oven/bun:1.2 bun x b4mal build
```

## Platform Notes

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Build execution | ✅ | ✅ | ✅ |
| Cache (L1) | ✅ | ✅ | ✅ |
| Remote cache (L2) | ✅ | ✅ | ✅ |
| Trace synthesis | ❌ (SIP) | ✅ (eBPF) | ❌ |
| Sandbox | ✅ (sandbox-exec) | ✅ (bwrap) | ❌ |

**Windows trace**: Use Docker with `--cap-add=SYS_PTRACE` for trace synthesis.
**macOS trace**: Use Docker for trace synthesis (macOS SIP blocks ptrace).
