# Sprint Plan — Go to Market (2026-06-19)

Goal: Make b4mal discoverable, installable, and useful on first try for a stranger.

## 🔴 Immediate — unblock adoption (this week)

- [x] **1. Publish to npm** ⚠️ **BLOCKED: npm token invalid (401). Run `npm login` and retry.**
  - `bun publish` or `npm publish` so `npm install -g b4mal` works
  - Verify the binary maps correctly (package.json `bin` field)
  - Acceptance: `npx b4mal --version` works on a fresh machine
  - Package.json prepped: bin→dist/index.js, files array added, prepublishOnly script added

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

- [x] **7. Create README badge SVGs**
  - `![built with b4mal](https://b4mal.dev/badge.svg)`
  - Minimal SVG, renders well on GitHub dark/light mode
  - Acceptance: badge renders correctly in README preview

- [x] **8. Fix CLAUDE.md architecture diagram — add GTM context**
  - Current CLAUDE.md is purely technical. Add install/publish commands, docs commands, and the GTM plan pointer
  - Acceptance: `bun run docs:build` and `bun publish` commands are documented

## 🔵 Medium-term — distribution (this quarter)

- [x] **9. Add incremental/verify mode (`b4mal check`)**
  - Let b4mal run alongside an existing build system as a correctness linter
  - `b4mal check` reads lockfile, verifies task isolation, reports collisions and shadowing — no execution
  - Acceptance: `b4mal check` exits 0 on valid config, exits 1 with collision report on conflicts

- [ ] **10. Write migration case study (Turborepo → b4mal)** ⚠️ **BLOCKED: wizard hangs on readline for large repos (shadcn-ui/ui). Needs non-interactive path debugging.**
  - Pick vercel/turbo or another recognizable repo, run the wizard, document every step
  - Include: before/after config, cache hit rates, build times, gotchas
  - Acceptance: `docs/case-studies/turborepo-migration.md` exists and builds

- [x] **11. Add VS Code extension scaffold**
  - Wraps the built-in LSP server for editor distribution
  - `vscode-extension/` with package.json, activation events, language config for `b4mal.config.json` and `b4mal.lock`
  - Acceptance: extension loads in VS Code, diagnostics appear on `b4mal.config.json`

## ⚪ Nice-to-have

- [x] **12. Run benchmark-init.ts against all 33 repos — publish results**
  - 35 repos tested: 31 GREEN (89%), 3 YELLOW (9%), 1 RED (3%)
  - GREEN: all JS/TS, Rust, Go, Python repos — 100% functional commands
  - YELLOW: shadcn-ui, date-fns, prisma — large file trees, AST discovery overload
  - RED: vercel/turbo — JSON parse error on turbo.json (likely comment/trailing comma)
