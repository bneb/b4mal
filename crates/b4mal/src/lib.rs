//! B4mal Rust integration crate.
//!
//! Provides:
//! - `is_available()` — whether a `b4mal` binary is on the PATH
//! - `attest()` — declare a task's resource claims and get a normalized claim back
//! - `discover_workspace_members()` — read `[workspace] members` from a Cargo.toml
//!
//! This crate deliberately has no dependencies: it shells out to the `b4mal`
//! binary rather than reimplementing its logic, so it stays in step with the CLI
//! instead of drifting from it.
//!
//! Note: there is no `b4mal_attest!` proc macro. That was planned and never
//! built; the previous doc comment described it as if it existed.

use std::process::Command;

/// Check if the `b4mal` binary is available on this system.
pub fn is_available() -> bool {
    Command::new("b4mal")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run `b4mal attest` with the given resource claims and return its JSON output.
///
/// Claims use the CLI's protocol prefixes, e.g. `fs:read:src`, `fs:write:dist`,
/// `env:NODE_ENV`, `port:8080`. Returns `Err` with the CLI's stderr when the
/// declaration is rejected, so callers can surface the reason.
pub fn attest(claims: &[&str]) -> Result<String, String> {
    let output = Command::new("b4mal")
        .arg("attest")
        .args(claims)
        .output()
        .map_err(|e| format!("Failed to run b4mal: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Discover Cargo workspace members by parsing `Cargo.toml`.
/// Returns a list of member crate paths relative to the workspace root.
///
/// This reads the `members` array only, and only in its single-line form. A
/// multi-line array or a `members = ["a"]` split across lines is not
/// understood; use a proper TOML parser if that matters.
pub fn discover_workspace_members(workspace_root: &str) -> Vec<String> {
    let cargo_path = std::path::Path::new(workspace_root).join("Cargo.toml");
    if !cargo_path.exists() {
        return vec![];
    }

    let content = std::fs::read_to_string(&cargo_path).unwrap_or_default();
    let mut members = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("members") {
            let list = trimmed
                .split('=')
                .nth(1)
                .unwrap_or("[]")
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']');
            for member in list.split(',').map(|s| s.trim().trim_matches('"')) {
                if !member.is_empty() {
                    members.push(member.to_string());
                }
            }
        }
    }

    members
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_discover_empty() {
        let members = discover_workspace_members("/nonexistent");
        assert!(members.is_empty());
    }

    #[test]
    fn test_is_available_does_not_panic() {
        // Should not panic even if b4mal is not installed
        let _ = is_available();
    }
}
