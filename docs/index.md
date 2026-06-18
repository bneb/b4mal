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
      link: https://github.com/b4mal/b4mal
  image:
    src: /logo.svg
    alt: B4mal

features:
  - icon: 🔒
    title: Formal Resource Verification
    details: B4mal proves that concurrent tasks cannot interfere via a prefix-tree collision detector. No more silent race conditions in your build pipeline.
  - icon: ⚡
    title: Ast-Normalized Caching
    details: Comment and whitespace changes don't invalidate the cache. B4mal hashes the logical structure of your code, not its formatting.
  - icon: 🔍
    title: Autonomous Trace Synthesis
    details: Point b4mal at any legacy build script and it will synthesize a correct DAG by tracing system calls — no manual configuration needed.
  - icon: 🛡️
    title: Execution Sandboxing
    details: Failed tasks are isolated into ephemeral workspaces. Debug without contaminating your working tree.
  - icon: 🌐
    title: Remote Cache (L2)
    details: Share cache across CI runners and developer machines via S3-compatible storage. Cold builds become cache hits.
  - icon: 📊
    title: Real-Time Dashboard
    details: Watch your build execute with live task status, cache hit metrics, and bottleneck detection.
---
