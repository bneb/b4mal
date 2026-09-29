# Benchmark Results

`b4mal init` tested against 35 real open-source repositories across 5 ecosystems.

**34/35 GREEN (97%).** One repository is YELLOW; none failed.

| Status | Repos |
|--------|-------|
| GREEN (lockfile with functional commands) | 34 (97%) |
| YELLOW (partial or unusable output) | 1 (3%) |
| RED (init failed) | 0 |

| Metric | Value |
|--------|-------|
| Total tasks generated | 1153 |
| Functional commands | 588 (51%) |
| Placeholder commands | 0 |

The 51% figure is not spread across the suite: every repository except one generates
100% functional commands. All 565 non-functional tasks come from a single repo —
see [Known gap](#known-gap-tanstackquery) below.

## All 35 repos

Measured with `bun run scripts/benchmark-init.ts --max 35`. Task counts move as the
upstream repositories change; these were taken in a single run.

| Repo | Tasks | Status |
|------|-------|--------|
| colinhacks/zod | 26 | GREEN |
| vitest-dev/vitest | 31 | GREEN |
| changesets/changesets | 21 | GREEN |
| **TanStack/query** | **565** | **YELLOW** |
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

## Known gap: TanStack/query

`init` discovers 565 tasks and produces **no functional commands and no
placeholders either** — a large but useless lockfile. Every other repository is
unaffected. This is the only thing standing between the suite and 35/35, and it
looks like a genuine defect in discovery rather than a cosmetic task-count
difference.

## How to reproduce

```bash
bun run scripts/benchmark-init.ts --max 35     # add --keep to retain the clones and JSON report
```

Generates `benchmark-report.json` with per-repo status, task counts and timing. It
exits non-zero when any repository is not GREEN, so it is usable as a check.
