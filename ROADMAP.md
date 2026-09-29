# Roadmap

**This file lists open work only. It deliberately makes no completion claims** — the
previous planning documents rotted precisely because they marked items done and
nothing re-checked them. See [Why this file exists](#why-this-file-exists).

Each item says where the gap is observable, so anyone can confirm it is still open
before starting and after finishing.

## A. Verification debt — claimed, not proven

These are the highest priority, because each is a case where the code may well be
correct but nobody has checked, and the docs assert a result anyway.

1. **L2 against real object storage.** The remote cache is verified end to end
   against an in-memory stub (`tests/fixtures/s3_stub.ts`, `tests/remote_cache_l2.test.ts`,
   `tests/remote_cache_signing.test.ts`). What that cannot exercise: AWS SigV4 request
   signing, real bucket policies, multipart uploads for large artifacts, and eventual
   consistency. *Needs credentials.*
2. **`b4mal trace`.** Linux-only by design and covered by no CI job, so its DAG
   synthesis has never run in this repository's pipeline. `tests/trace.test.ts` tests
   the synthesizer on recorded events, not the tracer itself.
3. **Windows.** No CI job, no Windows release binary (the publish matrix builds four
   targets, none of them Windows), and the artifact vault shells out to `tar` and
   `zstd`, which are not present by default there. The installation docs mark it
   untested.
4. **`BENCHMARKS.md`.** The hardware numbers in it have not been reproduced here, and
   the file names `src/benchmarks/crucible.ts` as the suite that produced them.
5. **VS Code extension.** `vscode-extension/` is a three-file scaffold that no CI job
   builds or tests.

## B. Functional gaps

6. **Remote artifacts are only authenticated when `B4MAL_CACHE_SECRET` is set.** Set
   it and entries are signed and verified; leave it unset and the remote cache is
   unauthenticated, which is documented in `docs/concepts/caching.md` and is the
   default. Deciding whether signing should be mandatory — or whether an unsigned
   entry should be rejected when a secret *is* configured but the entry predates it —
   is open.
7. **`providesEnv` has no injection.** It participates in conflict detection but no
   value is propagated between tasks, because a subprocess cannot set its parent's
   environment. `docs/concepts/security-model.md` says so. Either accept the field as
   conflict-detection only, or remove it.
8. **Failure sandboxing does not exist.** `.b4mal/shadow/<taskId>` is described in
   `artifacts/design/` and older docs; a failing task leaves its partial writes in
   place and only its dependents are skipped. `src/guard/sandbox.ts` is an unused
   helper for a *different* capability (OS-level execution sandboxing) and
   `B4MAL_STRICT_SANDBOX` was removed from the docs because nothing read it.
9. **`crates/b4mal::discover_workspace_members`** only understands a single-line
   `members = [...]` array. Multi-line arrays are silently ignored. Noted in the
   function's own doc comment.
10. **`NxMigrator` emits `npx nx run <target>`.** Nx documents `nx run <target>`, but
    whether a bare target resolves at a workspace root is unverified — if it does not,
    it should be `run-many -t <target>`.
11. **The L1 vault is keyed by absolute project path** (`~/.b4mal/artifacts/<sha256(projectRoot)>`),
    so a relocated checkout, or a CI job whose workspace path differs run to run,
    reuses nothing locally. L2 is unaffected (it keys on the logic hash).
    `ARCHITECTURE.md` notes this.

## C. Decisions needed

12. **Licensing direction.** `minting-station/` is a working Cloudflare Worker that
    mints license keys, and `artifacts/plans/windows-plugin-rust-license.md` plans a
    licensing portal — but the CLI has no license enforcement at all and the project is
    MIT. `install.sh` used to demand a key from a domain that does not resolve; that
    gate is gone. Either implement enforcement (and reconcile it with MIT) or retire
    the portal.
13. **Unused modules, kept deliberately.** `src/guard/sandbox.ts` and
    `src/trace/mock_tracer.ts` are referenced by nothing. They are small and represent
    real intent (execution sandboxing; a test double the trace subsystem's own comment
    tells tests to use), so they were left rather than deleted. Delete or wire them.
14. **`artifacts/truth.json`** describes version 0.5.0 from March 2026 — 238 tests
    across 23 files, and capabilities including `rust-vcm-syncing` and
    `git-history-audit` that no code provides. Nothing reads it. Delete it, or move it
    under a clearly historical path.

## D. Hygiene

15. **`scripts/add_headers.ts`** is run by nothing — it is not in `package.json` — and
    **10 of its 33 entries point at files that do not exist** (removed with the v0.5.0
    lineage). It now reports those and exits non-zero instead of skipping them
    silently; the table itself still needs pruning or the files restoring.
16. **`docs/case-studies/turborepo-migration.md`** was the acceptance criterion of a
    sprint item that was marked complete. It does not exist.

## How this file stays honest

Two mechanisms now exist that did not before, and both exist because drift went
unnoticed:

- **`tests/docs_claims.test.ts`** runs in CI and fails when the documentation and the
  code disagree — CLI commands that are not implemented, config fields absent from the
  schema, links to pages or domains that do not exist, and a short list of claims that
  have already been false once.
- **`.github/workflows/benchmark.yml`** re-runs the 35-repo init benchmark on a
  schedule. It regressed silently twice before this existed (35/35 recorded on
  2026-06-20, measuring 34/35 by 2026-09-29).

Neither covers prose like this file. If you close an item here, delete it — do not
tick it, which is how `artifacts/plans/sprint-go-to-market.md` came to record twelve
completed items when four of them were not.

## Why this file exists

The repository had a roadmap: `artifacts/plans/`, eleven plan documents plus a
design directory. It was not usable as one. Every sprint document was checked off
end to end, and several of those checkmarks were false — including a publish recorded
as blocked in its own annotation, a badge for a domain that does not resolve, and a
case study whose acceptance file was never written. Eight of the plans were design
records for work that had already shipped, so they were history rather than a plan.

`artifacts/plans/` is kept as a dated record. This file is where the actual remaining
work lives.
