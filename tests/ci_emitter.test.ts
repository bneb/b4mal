import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { CIEmitter } from "../src/shim/ci_emitter";
import * as fs from "fs";
import * as path from "path";

describe("CIEmitter (GitHub Actions)", () => {
    const testDir = path.join(process.cwd(), "tests/fixtures/ci_emitter");

    beforeAll(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test("generates valid GitHub Actions YAML structure", () => {
        const yaml = CIEmitter.emitGithubActions();
        
        // Basic workflow assertions
        expect(yaml).toContain("name: B4mal CI");
        expect(yaml).toContain("on:");
        expect(yaml).toContain("push:");
        expect(yaml).toContain("pull_request:");
        expect(yaml).toContain("workflow_dispatch:");
        
        // Security permissions
        expect(yaml).toContain("permissions: read-all");
        
        // Job structure assertions
        expect(yaml).toContain("jobs:");
        expect(yaml).toContain("build:");
        expect(yaml).toContain("runs-on: ubuntu-latest");
        
        // Concurrency
        expect(yaml).toContain("concurrency:");
        expect(yaml).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
        
        // Step assertions
        expect(yaml).toContain("uses: actions/checkout@v4");
        expect(yaml).toContain("b4mal build");
    });

    test("injects actions/cache for zero-config global remote caching", () => {
        const yaml = CIEmitter.emitGithubActions();
        
        expect(yaml).toContain("uses: actions/cache@v4");
        expect(yaml).toContain("path: .b4mal/");
        // The cache key uses the lockfile, dropping github.sha to avoid the 10GB limit thrashing trap
        expect(yaml).toContain("key: ${{ runner.os }}-b4mal-${{ hashFiles('**/b4mal.lock') }}");
        expect(yaml).toContain("restore-keys:");
        expect(yaml).toContain("${{ runner.os }}-b4mal-");
    });

    test("includes B4mal installation step pinned to a version", () => {
        const yaml = CIEmitter.emitGithubActions();
        expect(yaml).toContain("Install B4mal");
        // Pin global installations to prevent supply chain attacks
        // It should match semver or a valid tag, we test it doesn't just use @latest
        expect(yaml).toMatch(/npm i -g b4mal@\d+\.\d+\.\d+/);
    });

    test("infers toolchains based on directory contents (Node.js)", () => {
        const pkgPath = path.join(testDir, "package.json");
        fs.writeFileSync(pkgPath, '{"name": "test"}');
        
        const yaml = CIEmitter.emitGithubActions({ cwd: testDir });
        expect(yaml).toContain("uses: actions/setup-node@v4");
        // Should not inject npm ci if no lockfile
        expect(yaml).not.toContain("run: npm ci");
        
        fs.rmSync(pkgPath);
    });

    test("injects npm ci when package-lock.json is present", () => {
        const pkgPath = path.join(testDir, "package.json");
        const lockPath = path.join(testDir, "package-lock.json");
        fs.writeFileSync(pkgPath, '{"name": "test"}');
        fs.writeFileSync(lockPath, '{"name": "test"}');
        
        const yaml = CIEmitter.emitGithubActions({ cwd: testDir });
        expect(yaml).toContain("uses: actions/setup-node@v4");
        expect(yaml).toContain("npm ci");
        
        fs.rmSync(pkgPath);
        fs.rmSync(lockPath);
    });

    test("includes commented out deployment permissions", () => {
        const yaml = CIEmitter.emitGithubActions();
        expect(yaml).toContain("permissions: read-all");
        expect(yaml).toContain("# contents: write");
        expect(yaml).toContain("# id-token: write");
    });

    test("infers toolchains based on directory contents (Rust)", () => {
        // Mock a Cargo.toml existing
        const cargoPath = path.join(testDir, "Cargo.toml");
        fs.writeFileSync(cargoPath, '[package]\nname="test"');
        
        const yaml = CIEmitter.emitGithubActions({ cwd: testDir });
        expect(yaml).toContain("uses: dtolnay/rust-toolchain@stable");
        
        fs.rmSync(cargoPath);
    });
});
