// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// b4mal Core Shim — Rust Edition (v2.0.0)
//
// Zero-dependency bridge from Rust tests to the b4mal engine.
// Drop this file into your Rust project's `src/` or `tests/` directory.
//
// The shim communicates with the locally-installed `b4mal` binary
// via `std::process::Command` — no serde, no reqwest, no tokio.
//
// Usage:
//   use b4mal::CoreShield;
//   CoreShield::attest("test_name", &["fs:data/", "env:DB_URL"]);
//
// Or with the macro:
//   core_test!(test_name, ["fs:data/", "env:DB_URL"], { ... });
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

use std::process::Command;

/// The Core Shield: zero-dependency bridge to the b4mal engine.
///
/// Communicates resource claims to the locally-installed `b4mal` binary.
/// If the binary is not found, the shim silently degrades — your tests
/// continue to run without protection, but without formal isolation proofs.
pub struct CoreShield;

impl CoreShield {
    /// Attest that this block of code requires access to specific resources.
    ///
    /// This triggers a Path-based Isolation check in the b4mal engine.
    /// The engine will verify that no other concurrent test claims
    /// overlapping resources (the disjointness constraint).
    ///
    /// Resource format:
    ///   - `fs:<path>`           — File read (default)
    ///   - `fs:read:<path>`      — Explicit file read
    ///   - `fs:write:<path>`     — File write (exclusive)
    ///   - `env:<VAR>`           — Environment variable read
    ///   - `env:write:<VAR>`     — Environment variable write
    ///   - `port:<number>`       — Network port (exclusive)
    ///
    /// # Graceful Degradation
    /// If `b4mal` is not in PATH, this is a no-op.
    /// Your tests always run, with or without the engine.
    pub fn attest(task_name: &str, resources: &[&str]) {
        let result = Command::new("b4mal")
            .arg("attest")
            .arg(task_name)
            .args(resources)
            .env("B4MAL_CALLER", "rust-shim-v2.0.0")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        // Silent failure: if b4mal isn't installed, we don't panic.
        // The test runs unprotected but functional.
        match result {
            Ok(mut child) => { let _ = child.wait(); }
            Err(_) => { /* b4mal not installed — graceful degradation */ }
        }
    }

    /// Check if the b4mal engine is available in PATH.
    pub fn is_available() -> bool {
        Command::new("b4mal")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
    }

    /// Get the shim version string.
    pub fn version() -> &'static str {
        "rust-shim-v2.0.0"
    }
}

/// Helper macro for clean, declarative resource claims in tests.
///
/// Wraps a test function with an attestation call, declaring
/// the resources this test needs exclusive access to.
///
/// # Example
/// ```rust
/// mod b4mal;
/// use b4mal::{CoreShield, core_test};
///
/// core_test!(
///     test_database_migration,
///     ["fs:write:migrations/", "env:DATABASE_URL", "port:5432"],
///     {
///         // Your test logic here.
///         // The b4mal engine now knows this test writes to migrations/,
///         // reads DATABASE_URL, and needs exclusive port 5432.
///         assert!(true);
///     }
/// );
/// ```
#[macro_export]
macro_rules! core_test {
    ($name:ident, [$($resource:expr),* $(,)?], $body:block) => {
        #[test]
        fn $name() {
            $crate::CoreShield::attest(
                stringify!($name),
                &[$($resource),*],
            );
            $body
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_version_is_correct() {
        assert_eq!(CoreShield::version(), "rust-shim-v2.0.0");
    }

    #[test]
    fn attest_does_not_panic_when_binary_missing() {
        // This should silently degrade, never panic
        CoreShield::attest("test_graceful", &["fs:nonexistent/"]);
    }

    core_test!(
        test_macro_compiles,
        ["fs:read:Cargo.toml", "env:RUST_LOG"],
        {
            assert_eq!(2 + 2, 4);
        }
    );
}
