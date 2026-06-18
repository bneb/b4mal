# Design Plan: Documentation Site

## Status: Phase 1 — DESIGN

## Problem
No user-facing documentation. README has 5-line quick start. No getting-started guide, config reference, migration guides, API reference, or troubleshooting.

## Solution
VitePress static site at `docs/` directory, deployed to `docs.b4mal.dev`. Single command: `bun run docs:dev` / `bun run docs:build`.

### Site Structure
```
docs/
  .vitepress/config.ts
  index.md                    # Hero + quick start
  guide/
    getting-started.md        # 5-minute onboarding
    installation.md           # All install methods
    configuration.md          # b4mal.config.json reference
    migration/
      turborepo.md            # Migration from Turborepo
      nx.md                   # Migration from Nx
      lerna.md                # Migration from Lerna
  concepts/
    determinism.md            # Why determinism matters
    resource-isolation.md     # How formal verification works
    caching.md                # L1/L2 cache architecture
  reference/
    cli.md                    # All CLI commands
    schema.md                 # TaskConfigSchema reference
    b4mal-lock.md             # Lockfile format
  api/
    config-types.md           # TypeScript type reference
  community/
    contributing.md
    security.md
```

### Content Priority
1. Getting started (must have)
2. Configuration reference (must have)
3. CLI reference (must have)
4. Migration guides (high value for adoption)
5. Concepts (differentiator)

### Deployment
GitHub Pages via `.github/workflows/docs.yml` on push to main, deploying `docs/.vitepress/dist/` to `gh-pages` branch.

### Files
| File | Purpose |
|------|---------|
| `docs/` directory with VitePress | Documentation site |
| `package.json` scripts | `docs:dev`, `docs:build` |
| `.github/workflows/docs.yml` | Deploy on push to main |
