# Benchmark Results

`b4mal init` tested against 35 real open-source monorepos across 5 ecosystems.

**35/35 GREEN — 100% functional commands.** Zero failures, zero placeholders.

| Ecosystem | Repos tested | Result |
|-----------|-------------|--------|
| TypeScript (pnpm) | 10 | 100% GREEN |
| JavaScript (npm) | 5 | 100% GREEN |
| TypeScript (large) | 5 | 100% GREEN |
| Rust | 5 | 100% GREEN |
| Go | 3 | 100% GREEN |
| Python | 3 | 100% GREEN |
| Mixed / polyglot | 4 | 100% GREEN |

## All 35 repos

| # | Repo | Tasks | Init time |
|---|------|-------|-----------|
| 1 | colinhacks/zod | 22 | 0.6s |
| 2 | vitest-dev/vitest | 29 | 0.8s |
| 3 | changesets/changesets | 12 | 0.9s |
| 4 | TanStack/query | 10 | 0.8s |
| 5 | pmndrs/zustand | 25 | 1.1s |
| 6 | remix-run/react-router | 35 | 1.1s |
| 7 | shadcn-ui/ui | 12 | 1.6s |
| 8 | date-fns/date-fns | 9 | 1.5s |
| 9 | markedjs/marked | 21 | 1.8s |
| 10 | nestjs/nest | 2 | 2.2s |
| 11 | babel/babel | 13 | 2.2s |
| 12 | eslint/eslint | 35 | 1.5s |
| 13 | prettier/prettier | 38 | 2.9s |
| 14 | webpack/webpack | 52 | 1.7s |
| 15 | rollup/rollup | 54 | 1.8s |
| 16 | vitejs/vite | 21 | 2.4s |
| 17 | axios/axios | 21 | 2.4s |
| 18 | evanw/esbuild | 2 | 2.8s |
| 19 | privatenumber/tsx | 9 | 1.9s |
| 20 | BurntSushi/ripgrep | 4 | 2.3s |
| 21 | sharkdp/bat | 3 | 2.9s |
| 22 | astral-sh/ruff | 4 | 2.6s |
| 23 | casey/just | 3 | 2.6s |
| 24 | sharkdp/fd | 3 | 2.3s |
| 25 | golang/tools | 2 | 3.7s |
| 26 | gohugoio/hugo | 2 | 3.5s |
| 27 | cli/cli | 2 | 2.8s |
| 28 | pypa/pip | 2 | 2.6s |
| 29 | python-poetry/poetry | 2 | 2.9s |
| 30 | psf/black | 2 | 1.6s |
| 31 | prisma/prisma | 3 | 3.1s |
| 32 | nuxt/nuxt | 33 | 2.1s |
| 33 | tauri-apps/tauri | 12 | 2.7s |
| 34 | vercel/turbo | 20 | 2.3s |
| 35 | nrwl/nx | 20 | 1.9s |

## How to reproduce

```bash
bun run scripts/benchmark-init.ts --keep
```

Generates `benchmark-report.json` with per-repo status, task counts, and timing.
