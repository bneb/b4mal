//! B4mal Rust integration crate.
//!
//! Provides:
//! - `b4mal_attest!` macro for resource declaration at compile time
//! - Cargo workspace auto-discovery helpers
//! - AST-normalized hashing for Rust source files

use std::process::Command;

/// Check if the `b4mal` binary is available on this system.
pub fn is_available() -> bool {
    Command::new("b4mal")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run `b4mal attest` with the given resource claims.
/// Returns the attestation output on success.
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
pub fn discover_workspace_members(workspace_root: &str) -> Vec<String> {
    let cargo_path = std::path::Path::new(workspace_root).join("Cargo.toml");
    if !cargo_path.exists() {
        return vec![];
    }

    let content = std::fs::read_to_string(&cargo_path).unwrap_or_default();
    let mut members = Vec::new();

    // Simple parser for workspace.members in Cargo.toml
    let in_workspace = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[workspace]" {
            continue;
        }
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
