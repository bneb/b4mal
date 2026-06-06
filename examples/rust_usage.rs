// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// B4mal Rust Shim — Example Usage
//
// This file demonstrates how to integrate the b4mal Core Shield
// into an existing Rust test suite.
//
// Step 1: Copy `b4mal.rs` into your project's `src/` directory.
// Step 2: Add `mod b4mal;` to your test file.
// Step 3: Use `core_test!` to declare resource claims.
//
// Your tests run exactly the same, with or without the b4mal engine
// installed. The shim is a zero-cost abstraction when the engine is absent.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Assume b4mal.rs is in the same `src/` directory
#[path = "../src/b4mal.rs"]
mod b4mal;
use b4mal::CoreShield;

// ─── Example 1: Manual Attestation ───────────────────────────────────────────
//
// Use CoreShield::attest() directly for fine-grained control.

#[test]
fn test_quic_handshake() {
    // Declare: this test needs the certs directory and QUIC_PORT
    CoreShield::attest("test_quic_handshake", &[
        "fs:read:certs/",
        "env:QUIC_PORT",
        "port:4433",
    ]);

    // Your actual test logic...
    let handshake_ok = true; // placeholder
    assert!(handshake_ok, "QUIC handshake should succeed");
}

// ─── Example 2: Macro-Based Declaration ──────────────────────────────────────
//
// The core_test! macro combines #[test] + attestation in one step.

core_test!(
    test_database_migration,
    [
        "fs:write:migrations/",
        "fs:read:schema.sql",
        "env:DATABASE_URL",
        "port:5432",
    ],
    {
        // The b4mal engine now knows:
        //   - This test WRITES to migrations/
        //   - This test READS schema.sql
        //   - This test READS DATABASE_URL
        //   - This test needs EXCLUSIVE port 5432
        //
        // If another concurrent test also claims port:5432,
        // the FormalShadow will detect the collision.
        let migration_applied = true;
        assert!(migration_applied);
    }
);

// ─── Example 3: Read-Heavy Test ──────────────────────────────────────────────
//
// Multiple concurrent read-only tests are always safe.

core_test!(
    test_config_parsing,
    [
        "fs:read:config/app.toml",
        "fs:read:config/logging.toml",
        "env:RUST_LOG",
    ],
    {
        // Pure reads — this test can safely run in parallel with
        // any other test that only reads these resources.
        assert_eq!(1 + 1, 2);
    }
);

// ─── Example 4: Graceful Degradation Check ───────────────────────────────────

#[test]
fn test_shim_availability() {
    if CoreShield::is_available() {
        println!("B4mal engine detected — formal isolation active");
    } else {
        println!("[WARN] B4mal not installed — tests run without protection");
    }
    // Either way, the test runs fine
    assert!(true);
}
