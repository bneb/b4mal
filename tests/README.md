# `tests/`

The exhaustive validation suite for `b4mal`. 

We adhere to a strict test-driven engineering philosophy. Every module is covered by focused, deterministic unit and integration tests. The suite ensures that architectural shifts—such as replacing a generic `Satisfiability Modulo Theories` solver with an $O(N \cdot M)$ `Prefix Tree`—do not compromise the mathematical guarantees of the orchestrator.

Run the suite utilizing the `Bun` test runner:

```bash
bun test
```
