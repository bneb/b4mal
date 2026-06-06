// Tests: Config Impact Resolution (RED-to-GREEN)
//
// Validates that the ConfigResolver correctly classifies environment
// variables and compiler flags into the three identity layers:
//   Layer 1: LogicHash (feature flags, cfg attributes)
//   Layer 2: ClaimHash (resource claims, paths)
//   Layer 3: PlatformHash (opt-level, target, codegen)

import { describe, test, expect } from "bun:test";
import { ConfigResolver, type ResolvedConfig } from "../src/core/config_resolver";
import { TaskIdentity } from "../src/core/identity";

// ─── Noise Filtering ─────────────────────────────────────────────────────────

describe("ConfigResolver - Noise Filtering", () => {
    test("changing LOG_LEVEL does not change any identity hash", () => {
        const baseEnv = { RUST_LOG: "debug", HOME: "/home/testuser", PATH: "/usr/bin" };
        const changedEnv = { RUST_LOG: "info", HOME: "/home/testuser", PATH: "/usr/bin" };

        const idA = TaskIdentity.compute("cargo build", [], baseEnv);
        const idB = TaskIdentity.compute("cargo build", [], changedEnv);

        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);
        expect(idA.platformHash).toBe(idB.platformHash);
    });

    test("changing TERM, COLORTERM, or EDITOR does not affect any hash", () => {
        const envA = { TERM: "xterm-256color", EDITOR: "vim" };
        const envB = { TERM: "screen", EDITOR: "nano" };

        const idA = TaskIdentity.compute("rustc main.rs", [], envA);
        const idB = TaskIdentity.compute("rustc main.rs", [], envB);

        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);
        expect(idA.platformHash).toBe(idB.platformHash);
    });
});

// ─── Optimization Invariance ─────────────────────────────────────────────────

describe("ConfigResolver - Optimization Invariance", () => {
    test("changing opt-level changes PlatformHash but not LogicHash or ClaimHash", () => {
        const flagsA = ["-C", "opt-level=2"];
        const flagsB = ["-C", "opt-level=3"];

        const idA = TaskIdentity.compute("rustc main.rs", flagsA, {});
        const idB = TaskIdentity.compute("rustc main.rs", flagsB, {});

        // Logic and claims are unaffected by optimization level
        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);

        // Platform hash DOES change — different binary output
        expect(idA.platformHash).not.toBe(idB.platformHash);
    });

    test("changing target-cpu changes PlatformHash only", () => {
        const idA = TaskIdentity.compute("rustc main.rs", ["-C", "target-cpu=native"], {});
        const idB = TaskIdentity.compute("rustc main.rs", ["-C", "target-cpu=skylake"], {});

        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);
        expect(idA.platformHash).not.toBe(idB.platformHash);
    });
});

// ─── Feature Flag Sensitivity ────────────────────────────────────────────────

describe("ConfigResolver - Feature Flag Sensitivity", () => {
    test("adding a Rust feature flag triggers a total identity refresh", () => {
        const flagsA = ["--cfg", 'feature="json"'];
        const flagsB = ["--cfg", 'feature="json"', "--cfg", 'feature="ssl"'];

        const idA = TaskIdentity.compute("rustc main.rs", flagsA, {});
        const idB = TaskIdentity.compute("rustc main.rs", flagsB, {});

        // Logic hash MUST change — conditional compilation branches differ
        expect(idA.logicHash).not.toBe(idB.logicHash);
    });

    test("RUSTFLAGS with cfg changes LogicHash", () => {
        const envA = { RUSTFLAGS: '--cfg feature="core"' };
        const envB = { RUSTFLAGS: '--cfg feature="core" --cfg feature="net"' };

        const idA = TaskIdentity.compute("cargo build", [], envA);
        const idB = TaskIdentity.compute("cargo build", [], envB);

        expect(idA.logicHash).not.toBe(idB.logicHash);
    });
});

// ─── Deterministic Sorting ───────────────────────────────────────────────────

describe("ConfigResolver - Deterministic Sorting", () => {
    test('[ "-A", "-B" ] and [ "-B", "-A" ] produce the same Config Hash', () => {
        const idA = TaskIdentity.compute("rustc", ["-A", "-B"], {});
        const idB = TaskIdentity.compute("rustc", ["-B", "-A"], {});

        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);
        expect(idA.platformHash).toBe(idB.platformHash);
    });

    test("env var insertion order does not affect hashes", () => {
        const envA = { CARGO_TARGET_DIR: "/tmp/a", CARGO_HOME: "/home/.cargo" };
        const envB = { CARGO_HOME: "/home/.cargo", CARGO_TARGET_DIR: "/tmp/a" };

        const idA = TaskIdentity.compute("cargo build", [], envA);
        const idB = TaskIdentity.compute("cargo build", [], envB);

        expect(idA.logicHash).toBe(idB.logicHash);
        expect(idA.claimHash).toBe(idB.claimHash);
        expect(idA.platformHash).toBe(idB.platformHash);
    });
});
