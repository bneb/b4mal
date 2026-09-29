# Resource Isolation

B4mal formally verifies that concurrent tasks never interfere with each other's filesystem or environment resources.

## The prefix tree

Before any wave of parallel tasks executes, B4mal inserts every declared resource claim into a **prefix tree**. A claim is a protocol-prefixed path:

- `fs:dist/bundle.js` — a filesystem path
- `env:PORT` — an environment variable
- `db:primary` — a custom resource (database, port, etc.)

The prefix tree detects overlapping claims: if task A writes to `fs:dist/` and task B reads from `fs:dist/bundle.js`, those paths overlap. B4mal detects this and either serializes the tasks (adds a dependency edge) or, if they're in the same wave, reports a collision.

## Formal verification model

The verification uses a set-theoretic model:

```
(W₁ ∩ (R₂ ∪ W₂)) = ∅  ∧  (W₂ ∩ (R₁ ∪ W₁)) = ∅
```

Task A's writes must not overlap with Task B's reads or writes, and vice versa. If this invariant holds for all task pairs in a wave, the wave is **provably safe** to execute in parallel.

## Attestations

When a wave passes verification, B4mal records an **isolation attestation** containing the verifier identity, the task set, a timestamp, and a SHA-256 digest over that payload.

It is a digest, **not a signature**. There is no key material involved, so it does not establish who produced it — it only makes the verified task set tamper-evident if you retain the digest somewhere trustworthy and compare later. The `signature` field in the attestation schema is an explicit placeholder for a future signed version and is never populated. Treat attestations as a local audit record, not as cryptographic proof of correctness.

## Shadowing detection

Beyond wave-level verification, B4mal also performs **shadow analysis** across the full DAG. Shadowing occurs when a downstream task writes to the same path as an upstream task, deterministically overwriting the upstream output before anything consumes it. B4mal detects and reports these silently-wasted computations.
