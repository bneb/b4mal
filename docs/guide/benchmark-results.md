# Benchmark Results

`b4mal init` tested against 35 real open-source repositories across 5 ecosystems.

| Status | Repos |
|--------|-------|
| GREEN (lockfile with functional commands) | 35 (100%) |
| YELLOW (partial or unusable output) | 0 |
| RED (init failed) | 0 |

| Metric | Value |
|--------|-------|
| Total tasks generated | 598 |
| Functional commands | 598 (100%) |
| Placeholder commands | 0 |

These are measured values rather than a headline: run the command below and compare.
The script exits non-zero whenever any repository is not GREEN, so it doubles as a
check.

`.github/workflows/benchmark.yml` runs it daily and on demand. That was added because
this page recorded 35/35 GREEN on 2026-06-20 and was measuring 34/35 by 2026-09-29
without anyone noticing — a benchmark that only runs when someone remembers is a
snapshot, not a result.

## All 35 repos

| Repo | Tasks | Status |
|------|-------|--------|
| colinhacks/zod | 26 | GREEN |
| vitest-dev/vitest | 31 | GREEN |
| changesets/changesets | 21 | GREEN |
| TanStack/query | 10 | GREEN |
| pmndrs/zustand | 25 | GREEN |
| remix-run/react-router | 33 | GREEN |
| shadcn-ui/ui | 16 | GREEN |
| date-fns/date-fns | 9 | GREEN |
| markedjs/marked | 21 | GREEN |
| nestjs/nest | 2 | GREEN |
| babel/babel | 13 | GREEN |
| eslint/eslint | 35 | GREEN |
| prettier/prettier | 38 | GREEN |
| webpack/webpack | 81 | GREEN |
| rollup/rollup | 56 | GREEN |
| vitejs/vite | 21 | GREEN |
| axios/axios | 21 | GREEN |
| evanw/esbuild | 2 | GREEN |
| privatenumber/tsx | 10 | GREEN |
| BurntSushi/ripgrep | 4 | GREEN |
| sharkdp/bat | 3 | GREEN |
| astral-sh/ruff | 4 | GREEN |
| casey/just | 3 | GREEN |
| sharkdp/fd | 3 | GREEN |
| golang/tools | 2 | GREEN |
| gohugoio/hugo | 2 | GREEN |
| cli/cli | 2 | GREEN |
| pypa/pip | 2 | GREEN |
| python-poetry/poetry | 2 | GREEN |
| psf/black | 2 | GREEN |
| prisma/prisma | 11 | GREEN |
| nuxt/nuxt | 38 | GREEN |
| tauri-apps/tauri | 15 | GREEN |
| vercel/turbo | 14 | GREEN |
| nrwl/nx | 20 | GREEN |

Task counts move as the upstream repositories change; these come from a single run.

## What the numbers depend on

`init` migrates an existing build config when it finds one — `turbo.json`, `nx.json`
or `lerna.json` ahead of `package.json` scripts. If migration throws, the wizard
falls back to AST discovery, which emits one placeholder task per source file. That
fallback is why this page previously reported 34/35: `TanStack/query`'s `nx.json`
uses the object form of `dependsOn`, the migrator crashed on it, and the fallback
produced 565 placeholder tasks for a lockfile that could not build anything. The
migrator handles both shapes now — see `tests/init_migration.test.ts`.

A repository whose config is not recognised will still land on the AST path. If a
run here drops below 35/35, that gap is where to look first.

## How to reproduce

```bash
bun run scripts/benchmark-init.ts --max 35     # add --keep to retain the clones and JSON report
```

Generates `benchmark-report.json` with per-repo status, task counts and timing.
