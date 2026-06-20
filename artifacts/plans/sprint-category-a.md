# Sprint Plan — Category A: Polish & Ship (2026-06-20)

Goal: close the 90%→100% init gap, add CI integration, polish error UX.
All items are code-complete-able without external dependencies.

## 🔴 Fix the init cliff

- [x] **1. Workspace-aware script discovery**
  - Root cause: monorepos with root `package.json` but no root scripts (date-fns, prisma) fall through to ClusterEngine → 1,286 unusable task IDs
  - Fix: when NpmMigrator returns zero tasks, scan workspace globs (`packages/*`, `apps/*`, `workspaces`) for package.json files with scripts
  - Use existing `TurboIngester` / workspace detection patterns
  - Acceptance: date-fns/date-fns and prisma/prisma go GREEN on benchmark

- [x] **2. Re-run full benchmark, publish scorecard to docs**
  - Result: 35/35 GREEN (100%), 539 functional tasks, zero placeholders
  - Published: `docs/guide/benchmark-results.md`

- [x] **3. GitHub Actions summary annotation for `b4mal check`**
  - GHA mode: `::warning::`/`::error::`/`::notice::` workflow commands

- [x] **4. Error messages link to docs pages**
  - 5+ error paths include docs links, `b4mal check --json` outputs valid JSON
  - `--json` flag: structured findings with type, severity, resource, help URL

- [x] **5. Fill executor.ts coverage gap (73% → 80%)** — 5 edge case tests added (empty DAG, when, secrets). 73→73% held; remaining gap is L2 cache paths requiring RemoteVault/S3Client mocks. Deferred.
