// Tests: The Public Beta Manifest (v1.6.0 — RED PHASE)
//
// Validates the Core Badge Generator, Init Idempotency, Language Discovery,
// and Proposal Linkage for the final public release.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { BadgeGenerator } from "../src/reporter/badge_generator";
import { InitCommand } from "../src/cli/init";
import { ReadmeGenerator } from "../src/reporter/readme_generator";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_DIR = join(process.cwd(), ".test_manifest");

beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Core Badge Engine ──────────────────────────────────────────────────

describe("BadgeGenerator - Fidelity", () => {
    test("generates valid SVG with correct hours saved and hex colors", () => {
        const svg = BadgeGenerator.generate(2.90);

        // Core SVG structure checks
        expect(svg).toContain("<svg");
        expect(svg).toContain("</svg>");

        // Value insertion
        expect(svg).toContain("2.9h Recovered");

        // Hex color aesthetics (#00FF00 on #1A1A1A)
        expect(svg).toContain("#00FF00"); // Text or accent
        expect(svg).toContain("#1A1A1A"); // Background
    });

    test("handles zero-hours edge case gracefully", () => {
        const svg = BadgeGenerator.generate(0);
        expect(svg).toContain("0.0h Recovered");
    });
});

// ─── The 'Interactive Init' ──────────────────────────────────────────────────

describe("InitCommand - Idempotency & Discovery", () => {
    test("idempotent directory setup preserves existing files", async () => {
        const b4malDir = join(TEST_DIR, ".b4mal");
        const licensePath = join(b4malDir, "license.key");

        // First run
        await InitCommand.setupDirectory(TEST_DIR);
        expect(existsSync(b4malDir)).toBe(true);
        expect(existsSync(join(b4malDir, ".gitignore"))).toBe(true);

        const gitignoreContent = await Bun.file(join(b4malDir, ".gitignore")).text();
        expect(gitignoreContent).toContain("cache.db");

        // Simulate having a license key
        writeFileSync(licensePath, "MOCK_LICENSE_DATA");

        // Second run (Idempotency)
        await InitCommand.setupDirectory(TEST_DIR);

        // License key should STILL be there
        expect(existsSync(licensePath)).toBe(true);
        expect(await Bun.file(licensePath).text()).toBe("MOCK_LICENSE_DATA");
    });

    test("accurately discovers languages based on project structure", async () => {
        // Setup mock project
        const projectDir = join(TEST_DIR, "mock_project");
        mkdirSync(projectDir);
        mkdirSync(join(projectDir, "src"));
        mkdirSync(join(projectDir, "scripts"));

        // Add some files
        writeFileSync(join(projectDir, "Cargo.toml"), ""); // Indicates Rust
        writeFileSync(join(projectDir, "src", "main.rs"), "");
        writeFileSync(join(projectDir, "scripts", "analyze.py"), ""); // Indicates Python
        // Deliberately no TypeScript files

        const langs = await InitCommand.discoverLanguages(projectDir);

        expect(langs).toContain("python");
        expect(langs).toContain("rust");
        expect(langs).not.toContain("typescript");
    });
});

// ─── README Proposal Linkage ─────────────────────────────────────────────────

describe("ReadmeGenerator - Linkage", () => {
    test("generates README linking to local proposal", () => {
        const readme = ReadmeGenerator.generate();

        // Hierarchy checks
        expect(readme).toContain("Stop paying the Cache Miss Overhead");
        expect(readme).toContain("curl -fsSL https://b4mal.dev/install.sh | sh");
        expect(readme).toContain("Core Heatmap"); // Formal shadow explanation

        // Linkage check
        expect(readme).toContain("[optimization_report.md]");
    });
});
