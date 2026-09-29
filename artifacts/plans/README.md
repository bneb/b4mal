# Planning artifacts (historical)

Everything in this directory is a **dated record**, not a plan of record. Treat it
as history.

Read [ROADMAP.md](../../ROADMAP.md) for the current state of open work.

## What to expect here

Ten of these documents are design notes written *before* the feature was built
(`watch-mode.md`, `dry-run-strict.md`, `lsp-completion.md`, `dashboard.md`,
`collision-detector-extension.md`, `remote-cache-l2.md`, `b4mal-config-ts.md` and
others). They describe intent at a point in time. Most of that intent shipped, which
makes them useful for understanding *why* something looks the way it does, and
misleading if read as a description of current behaviour. `b4mal-config-ts.md` still
says "Phase 3 — WRITE TESTS" for configuration that has been in use for months.

The sprint documents are the unreliable ones. They were written as checklists and
ticked off as work landed, but nothing ever re-checked them, so a tick means "believed
done at the time" rather than "verified". `sprint-go-to-market.md` recorded twelve
completed items and four of them were not:

- **Publish to npm** was ticked while carrying its own annotation that it was blocked
  on an invalid token. It only happened on 2026-09-29, under the `@bneb` scope, because
  the unscoped name is refused by npm's typosquat guard.
- **README badge SVGs** was ticked against `https://b4mal.dev/badge.svg`. That domain
  does not resolve, and the badge is not in the README.
- **Migration case study** was ticked with "acceptance: `docs/case-studies/turborepo-migration.md`
  exists and builds". It does not exist.
- **Benchmark results** recorded 31/35 GREEN with a failure list that matches no run
  anyone has reproduced since.

`sprint-category-a.md` recorded "35/35 GREEN (100%), 539 functional tasks" on
2026-06-20. The same script measured 34/35 with 588 of 1153 functional tasks by
2026-09-29, because nothing re-ran it. That regression is fixed, and
`.github/workflows/benchmark.yml` now re-runs it on a schedule so the next one is
noticed.

`truth.json` predates this work entirely — version 0.5.0, dated March 2026, describing
capabilities such as `rust-vcm-syncing` and `git-history-audit` that no code provides.
Nothing reads it. It is listed as open work in the roadmap.
