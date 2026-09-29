# Sprint Plan — Go to Market (2026-06-19)

Goal: Make b4mal discoverable, installable, and useful on first try for a stranger.

> **Annotated 2026-09-29.** This checklist was ticked off optimistically. The four
> items below are marked with their real status; the rest were verified. See
> `ROADMAP.md` for current open work.

## 🔴 Immediate — unblock adoption (this week)

- [x] **1. Publish to npm** — ⚠️ **Was ticked while blocked. Actually completed 2026-09-29.**
  - At the time of writing this carried its own annotation: "BLOCKED: npm token invalid (401)"
  - Published as `@bneb/b4mal@0.1.1`, not `b4mal` — npm refuses the unscoped name as
    too similar to the existing package `b4a`
  - The binary maps correctly once installed: `bin` is `dist/index.js`, and
    `npm install -g @bneb/b4mal` was verified to place a working `b4mal` on PATH
  - Acceptance `npx b4mal --version` does not hold: the scope is required

- [x] **2. Fix init for non-JS ecosystems (Rust, Go, Python)**
  - Current: 0/54 functional tasks for Rust repos (all `echo` placeholders)
  - Goal: `b4mal init` detects `Cargo.toml` → emits `cargo build`/`cargo test`; detects `go.mod` → emits `go build`/`go test`; detects `pyproject.toml` → emits `pip install`/`pytest`
  - Acceptance: benchmark-init.ts shows ≥80% functional tasks for Rust/Go/Python repos

- [x] **3. Drop version from 7.0.0 to 0.1.0**
  - v7.0.0 on a tool with zero users looks suspicious — signals "internal versioning" not "public stability"
  - Acceptance: `b4mal --version` prints `0.1.0`

- [x] **4. Launch docs site scaffold**
  - The project already has Vitepress configured (`docs/`)
  - Three pages minimum: Quickstart, Migration from Turborepo, How Caching Works
  - Acceptance: `bun run docs:build` succeeds, output is coherent

## 🟡 Short-term — make it trustworthy (this month)

- [x] **5. Write "b4mal vs. Turborepo" comparison page**
  - Honest, specific, table-driven
  - Cover: adoption friction, caching model, correctness guarantees, polyglot support, remote cache, pricing
  - Acceptance: page builds, every claim is verifiable from the codebase

- [x] **6. Write security model document**
  - TOCTOU protection, symlink breakout prevention, inode verification, formal attestations
  - Target audience: CISO evaluating build tooling for regulated environment
  - Acceptance: `docs/security-model.md` exists and builds

- [ ] **7. Create README badge SVGs** — ⚠️ **Not done. The URL in this item does not resolve.**
  - Planned as `![built with b4mal](https://b4mal.dev/badge.svg)`
  - `b4mal.dev` is NXDOMAIN, and no badge was ever added to the README
  - Any badge needs a host that exists; the docs site is not deployed

- [x] **8. Fix CLAUDE.md architecture diagram — add GTM context**
  - Current CLAUDE.md is purely technical. Add install/publish commands, docs commands, and the GTM plan pointer
  - Acceptance: `bun run docs:build` and `bun publish` commands are documented

## 🔵 Medium-term — distribution (this quarter)

- [x] **9. Add incremental/verify mode (`b4mal check`)**
  - Let b4mal run alongside an existing build system as a correctness linter
  - `b4mal check` reads lockfile, verifies task isolation, reports collisions and shadowing — no execution
  - Acceptance: `b4mal check` exits 0 on valid config, exits 1 with collision report on conflicts

- [ ] **10. Write migration case study (Turborepo → b4mal)** — ⚠️ **Not done. The acceptance file was never written.**
  - Wizard work landed (TurboMigrator v2 + JSONC support, graceful fallback)
  - Acceptance was "`docs/case-studies/turborepo-migration.md` exists and builds" —
    that directory does not exist
  - The `vs-turborepo.md` page also describes no head-to-head benchmark, so there are
    no measured numbers to put in a case study yet

- [x] **11. Add VS Code extension scaffold**
  - Wraps the built-in LSP server for editor distribution
  - `vscode-extension/` with package.json, activation events, language config for `b4mal.config.json` and `b4mal.lock`
  - Acceptance: extension loads in VS Code, diagnostics appear on `b4mal.config.json`

## ⚪ Nice-to-have

- [x] **12. Run benchmark-init.ts against all 33 repos — publish results** — ⚠️ **Numbers below are stale; superseded.**
  - Recorded at the time: 35 repos tested: 31 GREEN (89%), 3 YELLOW (9%), 1 RED (3%)
  - The YELLOW list (shadcn-ui, date-fns, prisma) matches no later run
  - Measured 2026-09-29: **35/35 GREEN, 598 of 598 functional tasks, 0 placeholders**
  - `docs/guide/benchmark-results.md` carries the current figures, and
    `.github/workflows/benchmark.yml` now re-runs this on a schedule
