# Design Plans: Windows, Plugin SDK, Licensing Portal, Rust Crate

## Feature #12: Windows Support
- Installation guide with Bun, Scoop, and manual methods
- Platform support matrix documenting feature availability per OS
- Docker-based trace synthesis for Windows

## Feature #9: Plugin SDK
- Plugin development guide with hook definitions (preBuild, postTask, onCacheHit, onError)
- WASM sandbox model (isolated, no fs/network, 5s timeout)
- Four first-party plugin descriptions (slack-notifier, bundle-size, license-check, vuln-scan)

## Feature #13: Licensing Portal
- Minting station API documentation (endpoints, schema, environment variables)
- Webhook handler already exists; added API spec for verify and list endpoints

## Feature #14: Rust Crate
- `crates/b4mal/` with Cargo.toml and src/lib.rs
- `b4mal_attest!` macro placeholder for compile-time resource declaration
- `discover_workspace_members()` for Cargo workspace auto-detection
- `is_available()` and `attest()` helpers wrapping the b4mal binary
