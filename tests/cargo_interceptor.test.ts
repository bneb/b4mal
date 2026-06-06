// Tests: Cargo Interceptor (v4.0.0 — RED-to-GREEN)
//
// Validates cargo metadata parsing, RUSTC_WRAPPER argument handling,
// and cache hit/miss logic for the compiler wrapper.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { CargoMetadataParser, type CrateGraph } from "../src/toolchain/cargo_metadata";
import {
    CargoInterceptor,
    type InterceptResult,
    type CompilationUnit,
} from "../src/toolchain/cargo_interceptor";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ─── Mock cargo metadata JSON ────────────────────────────────────────────────

const MOCK_METADATA = {
    packages: [
        {
            name: "my-crate",
            version: "0.1.0",
            id: "my-crate 0.1.0 (path+file:///project)",
            source: null,
            manifest_path: "/project/Cargo.toml",
            targets: [
                { name: "my-crate", kind: ["lib"], src_path: "/project/src/lib.rs" },
                { name: "main", kind: ["bin"], src_path: "/project/src/main.rs" },
            ],
            dependencies: [
                { name: "serde", req: "^1.0", kind: null },
                { name: "tokio", req: "^1.0", kind: null },
            ],
        },
        {
            name: "serde",
            version: "1.0.190",
            id: "serde 1.0.190 (registry+https://github.com/rust-lang/crates.io-index)",
            source: "registry+https://github.com/rust-lang/crates.io-index",
            manifest_path: "/home/.cargo/registry/src/serde-1.0.190/Cargo.toml",
            targets: [
                { name: "serde", kind: ["lib"], src_path: "/home/.cargo/registry/src/serde-1.0.190/src/lib.rs" },
            ],
            dependencies: [],
        },
    ],
    workspace_members: ["my-crate 0.1.0 (path+file:///project)"],
    target_directory: "/project/target",
    workspace_root: "/project",
    metadata: null,
};

// ─── Cargo Metadata Parsing ──────────────────────────────────────────────────

describe("CargoMetadataParser - Crate Graph", () => {
    test("parses packages into a crate graph", () => {
        const parser = new CargoMetadataParser();
        const graph = parser.parse(MOCK_METADATA);

        expect(graph.crates.length).toBe(2);
        expect(graph.crates[0].name).toBe("my-crate");
        expect(graph.crates[1].name).toBe("serde");
    });

    test("identifies workspace members vs external deps", () => {
        const parser = new CargoMetadataParser();
        const graph = parser.parse(MOCK_METADATA);

        const local = graph.crates.find(c => c.name === "my-crate");
        const external = graph.crates.find(c => c.name === "serde");

        expect(local!.isWorkspaceMember).toBe(true);
        expect(external!.isWorkspaceMember).toBe(false);
    });

    test("extracts correct dependency edges", () => {
        const parser = new CargoMetadataParser();
        const graph = parser.parse(MOCK_METADATA);

        const myCrate = graph.crates.find(c => c.name === "my-crate");
        expect(myCrate!.dependencies).toContain("serde");
        expect(myCrate!.dependencies).toContain("tokio");
    });

    test("extracts workspace root and target directory", () => {
        const parser = new CargoMetadataParser();
        const graph = parser.parse(MOCK_METADATA);

        expect(graph.workspaceRoot).toBe("/project");
        expect(graph.targetDirectory).toBe("/project/target");
    });
});

// ─── RUSTC_WRAPPER Logic ─────────────────────────────────────────────────────

describe("CargoInterceptor - RUSTC_WRAPPER", () => {
    test("parseRustcArgs extracts crate name and source file", () => {
        const interceptor = new CargoInterceptor();

        // Simulated rustc invocation args (as RUSTC_WRAPPER receives them)
        const args = [
            "/usr/local/bin/rustc",
            "--crate-name", "my_crate",
            "--edition=2021",
            "src/lib.rs",
            "--crate-type", "lib",
            "-C", "opt-level=2",
        ];

        const unit = interceptor.parseRustcArgs(args);

        expect(unit.crateName).toBe("my_crate");
        expect(unit.sourceFile).toBe("src/lib.rs");
        expect(unit.crateType).toBe("lib");
    });

    test("computeLogicHash produces deterministic hash for same inputs", () => {
        const interceptor = new CargoInterceptor();

        const unit: CompilationUnit = {
            crateName: "my_crate",
            sourceFile: "src/lib.rs",
            crateType: "lib",
            edition: "2021",
            features: [],
            args: ["--crate-name", "my_crate", "src/lib.rs"],
        };

        const hash1 = interceptor.computeLogicHash(unit);
        const hash2 = interceptor.computeLogicHash(unit);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(64); // SHA-256 hex
    });

    test("cache miss returns { action: 'compile' }", () => {
        const interceptor = new CargoInterceptor();

        const unit: CompilationUnit = {
            crateName: "never_cached",
            sourceFile: "src/lib.rs",
            crateType: "lib",
            edition: "2021",
            features: [],
            args: [],
        };

        const result = interceptor.checkCache(unit);

        expect(result.action).toBe("compile");
        expect(result.cached).toBe(false);
    });

    test("cache is persistent across CargoInterceptor instances", () => {
        const dbPath = path.join(os.tmpdir(), `cargo_interceptor_test_${Date.now()}.db`);
        const interceptor1 = new CargoInterceptor(dbPath);

        const unit: CompilationUnit = {
            crateName: "persistent_crate",
            sourceFile: "src/lib.rs",
            crateType: "lib",
            edition: "2021",
            features: [],
            args: [],
        };

        const hash = interceptor1.computeLogicHash(unit);
        interceptor1.cacheStore(hash, "/target/debug/libpersistent_crate.rlib");

        // Second instance simulating a new rustc process
        const interceptor2 = new CargoInterceptor(dbPath);
        const hit = interceptor2.checkCache(unit);

        expect(hit.action).toBe("skip");
        expect(hit.cached).toBe(true);
        expect(hit.artifactPath).toBe("/target/debug/libpersistent_crate.rlib");
    });
});
