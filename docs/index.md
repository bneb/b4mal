---
layout: home
title: B4mal

hero:
  name: B4mal
  text: Deterministic Build Orchestrator
  tagline: Fast, verified, reproducible builds for monorepos.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/bneb/b4mal
  image:
    src: /logo.svg
    alt: B4mal

features:
  - icon: 🔒
    title: Resource Isolation
    details: Every task declares the files, directories and env vars it touches. Overlapping claims between concurrent tasks are detected by a path-prefix tree and serialized before execution, instead of racing.
  - icon: ⚡
    title: Ast-Normalized Caching
    details: For tasks that declare no outputs, inputs are hashed by AST — so comment and formatting changes don't invalidate the cache. Tasks that produce artifacts are keyed on raw input content.
  - icon: 🧾
    title: DAG Audit
    details: b4mal check verifies a lockfile without executing it — reporting collisions, deterministic overwrites, and undeclared producer/consumer pairs the planner had to order for you.
  - icon: 🛡️
    title: Fail-Fast Scheduling
    details: When a task fails, its transitive dependents are skipped rather than run against inputs that were never produced. Independent tasks still complete.
  - icon: 🌐
    title: Remote Cache (L2)
    details: L2 is checked before L1 and pushed after a successful pack, so artifacts can be shared across CI runners via S3-compatible storage. All L2 failures are non-fatal.
  - icon: 📊
    title: Build Reports
    details: b4mal analyze writes a static HTML dashboard covering task timings, the slowest-task bottleneck and cache statistics.
---

::: warning Not yet implemented
Two features are described in older design notes but are **not implemented**: failure sandboxing into `.b4mal/shadow/<taskId>` (no clone-on-failure workspace exists — see [the security model](./concepts/security-model.md)), and `b4mal trace` on macOS or Windows, which is Linux-only. This page lists what the code does today.
:::
