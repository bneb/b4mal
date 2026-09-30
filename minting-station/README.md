# Minting Station — not part of the shipped product

This is a **Cloudflare Worker that mints license keys**. It is **not** used by the
b4mal CLI, and nothing in `src/` or `install.sh` references it.

- b4mal is MIT (`LICENSE`, `package.json`).
- The CLI performs **no license validation** and makes **no network calls** to any
  license service. There is no phone-home.
- This directory is retained as a historical/dormant artifact, not deployed by any
  workflow in `.github/workflows/`.

## Why it isn't wired up

b4mal's value proposition is *provable, hermetic, deterministic* builds. Requiring a
license-key round-trip to run a build would break air-gapped and offline CI, which
is a real enterprise requirement, and would contradict the product's own claims.

If b4mal ever ships a commercial tier, the honest surface is the hosted **L2 remote
cache** — a team paying for shared cache across a fleet is buying real value, with
no enforcement and no lock-in — not a license server inside the build tool.

See ROADMAP.md item 13 for the full decision.