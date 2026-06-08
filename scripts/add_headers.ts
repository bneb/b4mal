import * as fs from "fs";
import * as path from "path";

const descriptions: Record<string, string> = {
    "src/core/appendix_gen.ts": "Generates Merkle tree proofs and forensic appendices for execution verification.",
    "src/core/artifact_vault.ts": "Manages L1 (local) archive packing and unpacking via strictly bounded POSIX file descriptors and zstd.",
    "src/core/attestation_schema.ts": "Defines Zod schemas for verifying remote and local cache execution attestations.",
    "src/core/audit.ts": "Declares the foundational interfaces and types for the cryptographic auditing subsystem.",
    "src/core/audit_engine.ts": "Drives the continuous validation pipeline for state consistency and invariant checking.",
    "src/core/comment_stripper.ts": "Removes documentation and whitespace strings prior to logic hashing to avoid cache invalidation on non-functional changes.",
    "src/core/config_resolver.ts": "Resolves workspace configurations, merging local overrides with root project definitions.",
    "src/core/content_hasher.ts": "Computes SHA-256 hashes of filesystem trees to determine input determinism.",
    "src/core/core_bootstrap.ts": "Initializes the B4mal engine, instantiating the ledger, vault, and planner components.",
    "src/core/core_token.ts": "Manages cryptographic capabilities and access tokens for L2 cache synchronization.",
    "src/core/crypto.ts": "Provides standardized, low-level cryptographic primitives for hashing and signing.",
    "src/core/engine.ts": "The primary coordinator connecting the DAG planner, executors, and cache vaults.",
    "src/core/formal_shadow.ts": "Implements formal verification to prove absolute path disjointness between concurrent execution waves.",
    "src/core/identity.ts": "Resolves current machine and user identities for execution provenance tracking.",
    "src/core/logic_hasher.ts": "Computes structural hashes of task logic to enable L1/L2 cache keying.",
    "src/core/manifest.ts": "Parses and validates package and workspace manifests (e.g., package.json, Cargo.toml).",
    "src/core/project_scanner.ts": "Recursively scans workspaces to construct the initial dependency matrix.",
    "src/core/rust_auditor.ts": "Parses Rust macros and dependencies to determine strict execution boundaries for Cargo projects.",
    "src/core/rust_normalizer.ts": "Normalizes Rust syntax trees to provide stable logic hashes across trivial formatting changes.",
    "src/core/sqlite_ledger.ts": "Maintains a high-throughput SQLite WAL log of execution history and cache hits.",
    "src/core/telemetry_aggregator.ts": "Collects timing and execution trace data for the OpenTelemetry exporter.",
    "src/core/time_savings.ts": "Calculates the exact wall-clock milliseconds saved via L1 and L2 cache hits.",
    "src/core/volatility_forecaster.ts": "Predicts the likelihood of cache misses based on historical file modification rates.",
    "src/orchestrator/executor.ts": "Spawns and manages isolated subprocesses for execution wave tasks.",
    "src/orchestrator/planner.ts": "Resolves synthetic Directed Acyclic Graphs and groups tasks into parallel execution waves.",
    "src/reporter/badge_generator.ts": "Generates static SVG badges representing build status and performance.",
    "src/reporter/heatmap.ts": "Generates ASCII heatmaps representing cache hit rates and volatility.",
    "src/reporter/optimization_report.ts": "Compiles actionable recommendations to improve cache hit rates and DAG concurrency.",
    "src/reporter/proposal_template.ts": "Constructs HTML proposals summarizing CI execution pipelines.",
    "src/reporter/readme_generator.ts": "Auto-generates technical README components from current telemetry and configuration.",
    "src/reporter/shield_hud.ts": "Renders a real-time, interactive terminal HUD tracking execution progress.",
    "src/reporter/tui_hud.ts": "Renders a structured, text-based user interface for CI environments.",
    "src/telemetry/otlp_exporter.ts": "Exports standardized trace and metric data to OpenTelemetry collectors."
};

for (const [relPath, desc] of Object.entries(descriptions)) {
    const fullPath = path.join(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) continue;
    
    let content = fs.readFileSync(fullPath, "utf-8");
    
    // Strip existing leading block/line comments
    // This regex carefully matches comments at the very start of the file
    content = content.replace(/^(\s*(\/\*[\s\S]*?\*\/|\/\/.*$)\n)+/m, "").trimStart();
    
    // Some files might have leading newlines
    content = content.trimStart();
    
    const header = `/**
 * @file ${path.basename(relPath)}
 * @description ${desc}
 */\n\n`;
    
    fs.writeFileSync(fullPath, header + content);
    console.log(`Updated ${relPath}`);
}
