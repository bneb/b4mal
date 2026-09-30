# Roadmap

**This file lists open work only. It deliberately makes no completion claims** — the
previous planning documents rotted precisely because they marked items done and
nothing re-checked them. See [Why this file exists](#why-this-file-exists).

Each item says where the gap is observable, so anyone can confirm it is still open
before starting and after finishing.

## A. Verification debt — claimed, not proven

These are the highest priority, because each is a case where the code may well be
correct but nobody has checked, and the docs assert a result anyway.

1. ~~**L2 against real object storage.**~~ **Done 2026-09-30, against Cloudflare R2.**
   Verified end to end over the network, not against a stub: a signed artifact was
   pushed to R2, the entire L1 layer (ledger, vault and declared outputs) was
   deleted, and a rebuild restored the output from R2 **without re-executing the
   task** — proven by an execution counter that stayed at 1. Then, in the same
   session: a pull signed with a *different* secret was rejected and the task
   re-ran; an object corrupted in the bucket (same size, flipped bytes) was
   rejected and the task re-ran. All test objects were deleted afterwards and the
   empty prefix confirmed **by key listing**.

   Procedure: `scripts/verify-l2.sh` (env-driven; any S3-compatible endpoint).

   Still unexercised: AWS SigV4 against real AWS proper (R2 is S3-compatible but
   its own implementation), multipart uploads for artifacts large enough to need
   them, and eventual-consistency timing.
2. **`b4mal trace`.** Linux-only by design and covered by no CI job, so its DAG
   synthesis has never run in this repository's pipeline. `tests/trace.test.ts` tests
   the synthesizer on recorded events, not the tracer itself.
3. **Windows.** Partly addressed: a Windows binary is now in the publish matrix
   (cross-compiled from ubuntu, PE magic-number checked before upload) and ships
   with the next release. Still open: L1 caching does not work there, because the
   artifact vault shells out to `zstd` and Windows does not ship it — every run
   re-executes rather than restoring. A `windows-latest` CI job smoke-tests the
   rest, but the test suite cannot run there (`sh -c` throughout).
4. ~~**`BENCHMARKS.md`.**~~ **Done 2026-09-30.** Re-measured on the machine the file
   described (Apple M4, 10 cores, 24 GB — it matches) and every figure was wrong:
   write 938→266 MB/s, SHA-256 cold 1813→657, PrefixTree 86,116→17,950 proofs/s,
   zstd pack 126→66. One was *faster* than published (SQLite 7,931→10,783 tx/s),
   which is what showed the table was not one coherent run. The file is now a
   recorded run with environment, runtime, date and commit, and states plainly that
   I/O phases vary 2–3× and that the planner number is shape-dependent.

   The planner figure itself was the real find: the suite's 100,000-task benchmark
   gave every task in a chain the same output claim, forcing ~500 million
   serialisation edges — unplannable by any scheduler, so the "~146 ms" measured
   nothing. Behind it was a genuine O(n²) in dependency injection (every task
   compared against every accepted task). Fixed with a prefix-tree index and pinned
   differentially: 20,000 tasks went 6,024 ms → 448 ms, with a transcribed copy of
   the original scan asserting an identical edge set across 12 cases.
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
    so moving or re-cloning a checkout on a developer machine reuses nothing locally —
    every relocated project starts cold. L2 is unaffected (it keys on the logic hash),
    and CI is barely affected because a job's local disk is discarded anyway.
    `ARCHITECTURE.md` notes this.

## C. Decisions needed

12. ~~**`init` should write a config, not only a lock.**~~ **Done.** `init` now
    writes `b4mal.config.json` and derives `b4mal.lock` from it through the same
    Zod-validated path `build --sync` uses, so the lock is provably the config's
    output and the two cannot drift. Routing discovery through the validated path
    surfaced three latent defects that the lockfile write had been tolerating, all
    now fixed and regression-tested: npm script names that are illegal task ids
    (`test:unit`, `@scope/thing`), Nx/Turbo object-form `inputs`/`outputs`
    descriptors, and inferred dependency edges that dangle or close a cycle. The
    config⇄lock round trip is pinned field-by-field in `tests/roundtrip.test.ts`
    — `secrets`, `needsEnv` and `when` are each named explicitly, because those are
    the three that have silently broken in exactly this conversion before. The
    35-repo init benchmark is 35/35 GREEN, 600 tasks.
13. **Licensing direction.** **Decided: stay MIT, retire the portal.** The project is
    MIT in `package.json` and `LICENSE`; the CLI has no license enforcement anywhere
    (`grep -ri "license\|B4MAL_LICENSE" src/ install.sh` finds nothing), so
    `minting-station/` is a Worker with no client — dead infrastructure. Shipping an
    unused key-minting portal in-tree only invites the question "does this phone
    home?" (it does not, and it shouldn't).
    
    The decision is on the merits, not convenience: b4mal sells *provable, hermetic,
    deterministic* builds. License-key validation inside a build tool means a network
    round-trip to run a build, which breaks air-gapped and offline CI — a real
    enterprise requirement. If there's ever a commercial tier, the honest one is the
    hosted L2 remote cache (a team paying for shared cache across a fleet is buying
    real value), not a license server in the CLI. This matches how infra open-core
    actually works (HashiCorp, CockroachDB, Sentry): the paid surface is the hosted
    service, the core stays open and enforcement-free.
    
    Action: `minting-station/` is retained as a documented, non-shipping artifact —
    not wired into anything. The old `install.sh` license-key gate (which demanded a
    key from a domain that never resolved) is already gone.
14. **Unused modules, kept deliberately.** `src/guard/sandbox.ts` and
    `src/trace/mock_tracer.ts` are referenced by nothing. They are small and represent
    real intent (execution sandboxing; a test double the trace subsystem's own comment
    tells tests to use), so they were left rather than deleted. Delete or wire them.
15. **`artifacts/truth.json`** describes version 0.5.0 from March 2026 — 238 tests
    across 23 files, and capabilities including `rust-vcm-syncing` and
    `git-history-audit` that no code provides. Nothing reads it. Delete it, or move it
    under a clearly historical path.

## D. Hygiene

16. **`scripts/add_headers.ts`** is run by nothing — it is not in `package.json` — and
    **10 of its 33 entries point at files that do not exist** (removed with the v0.5.0
    lineage). It now reports those and exits non-zero instead of skipping them
    silently; the table itself still needs pruning or the files restoring.
17. **`docs/case-studies/turborepo-migration.md`** was the acceptance criterion of a
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
