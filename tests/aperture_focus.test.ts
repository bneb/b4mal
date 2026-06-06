// Tests: Core Aperture Engine (v3.0.0-alpha — RED-to-GREEN)
//
// Validates the focal isolation system: symlink projection,
// nested claim depth, independent apertures, and clean dissolution.

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { ApertureEngine, type ApertureConfig } from "../src/guard/aperture";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

let testProjectRoot: string;
let engine: ApertureEngine;
const openedApertures: string[] = [];

beforeAll(async () => {
    // Create a realistic mock project structure
    testProjectRoot = path.join(os.tmpdir(), "b4mal-aperture-test-" + Date.now());
    await fs.mkdir(path.join(testProjectRoot, "src", "core", "types"), { recursive: true });
    await fs.mkdir(path.join(testProjectRoot, "src", "compiler"), { recursive: true });
    await fs.mkdir(path.join(testProjectRoot, "config"), { recursive: true });
    await fs.mkdir(path.join(testProjectRoot, "include"), { recursive: true });

    // Populate with sentinel files
    await fs.writeFile(path.join(testProjectRoot, "src", "core", "types", "index.ts"), "export type ID = string;");
    await fs.writeFile(path.join(testProjectRoot, "src", "compiler", "parse.ts"), "export function parse() {}");
    await fs.writeFile(path.join(testProjectRoot, "config", "settings.json"), '{"debug": true}');
    await fs.writeFile(path.join(testProjectRoot, "include", "shared.h"), "#pragma once");

    engine = new ApertureEngine();
});

afterEach(async () => {
    // Clean up any apertures created during tests
    for (const ap of openedApertures) {
        try { await engine.closeAperture(ap); } catch { }
    }
    openedApertures.length = 0;
});

afterAll(async () => {
    // Remove the mock project
    await fs.rm(testProjectRoot, { recursive: true, force: true });
});

// ─── Focal Isolation ─────────────────────────────────────────────────────────

describe("ApertureEngine - Focal Isolation", () => {
    test("task with claim on src/ cannot see config/ directory", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "build-task",
            claims: ["fs:src/"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(aperturePath);

        // src/ symlink should exist
        const srcExists = await fs.lstat(path.join(aperturePath, "src"))
            .then(() => true).catch(() => false);
        expect(srcExists).toBe(true);

        // config/ should NOT exist in the aperture
        const configExists = await fs.lstat(path.join(aperturePath, "config"))
            .then(() => true).catch(() => false);
        expect(configExists).toBe(false);
    });

    test("multiple claims expand the focal view to only specified paths", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "multi-claim-task",
            claims: ["fs:src/compiler", "fs:config"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(aperturePath);

        // Both claimed paths should exist
        const compilerExists = await fs.lstat(path.join(aperturePath, "src", "compiler"))
            .then(() => true).catch(() => false);
        const configExists = await fs.lstat(path.join(aperturePath, "config"))
            .then(() => true).catch(() => false);

        expect(compilerExists).toBe(true);
        expect(configExists).toBe(true);

        // include/ should NOT exist (not claimed)
        const includeExists = await fs.lstat(path.join(aperturePath, "include"))
            .then(() => true).catch(() => false);
        expect(includeExists).toBe(false);
    });
});

// ─── Projection Depth ────────────────────────────────────────────────────────

describe("ApertureEngine - Projection Depth", () => {
    test("nested claim materializes the full directory tree", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "nested-claim",
            claims: ["fs:src/core/types"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(aperturePath);

        // The parent directories src/ and src/core/ must exist as real dirs
        const srcDir = await fs.lstat(path.join(aperturePath, "src"));
        expect(srcDir.isDirectory()).toBe(true);

        const coreDir = await fs.lstat(path.join(aperturePath, "src", "core"));
        expect(coreDir.isDirectory()).toBe(true);

        // The leaf claim is the symlink
        const typesLink = await fs.lstat(path.join(aperturePath, "src", "core", "types"));
        expect(typesLink.isSymbolicLink()).toBe(true);

        // Verify it resolves to the real source
        const resolved = await fs.readlink(path.join(aperturePath, "src", "core", "types"));
        expect(resolved).toBe(path.join(testProjectRoot, "src", "core", "types"));
    });
});

// ─── Conflict Prevention ─────────────────────────────────────────────────────

describe("ApertureEngine - Conflict Prevention", () => {
    test("two tasks with overlapping claims get independent apertures", async () => {
        const ap1 = await engine.openAperture({
            taskId: "reader-alpha",
            claims: ["fs:include"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(ap1);

        const ap2 = await engine.openAperture({
            taskId: "reader-beta",
            claims: ["fs:include"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(ap2);

        // Apertures must be at different paths
        expect(ap1).not.toBe(ap2);

        // Both should have valid symlinks to the same source
        const link1 = await fs.readlink(path.join(ap1, "include"));
        const link2 = await fs.readlink(path.join(ap2, "include"));

        expect(link1).toBe(path.join(testProjectRoot, "include"));
        expect(link2).toBe(path.join(testProjectRoot, "include"));
    });
});

// ─── Clean Dissolution ───────────────────────────────────────────────────────

describe("ApertureEngine - Clean Dissolution", () => {
    test("closeAperture removes the symlink tree", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "dissolve-test",
            claims: ["fs:src/compiler"],
            projectRoot: testProjectRoot,
        });

        // Verify it exists
        const existsBefore = await fs.lstat(aperturePath)
            .then(() => true).catch(() => false);
        expect(existsBefore).toBe(true);

        // Dissolve
        await engine.closeAperture(aperturePath);

        // Verify it's gone
        const existsAfter = await fs.lstat(aperturePath)
            .then(() => true).catch(() => false);
        expect(existsAfter).toBe(false);
    });

    test("closeAperture does NOT delete the source code", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "safety-test",
            claims: ["fs:src/compiler"],
            projectRoot: testProjectRoot,
        });

        await engine.closeAperture(aperturePath);

        // The REAL source code must survive
        const sourceExists = await fs.lstat(path.join(testProjectRoot, "src", "compiler", "parse.ts"))
            .then(() => true).catch(() => false);
        expect(sourceExists).toBe(true);

        const content = await fs.readFile(
            path.join(testProjectRoot, "src", "compiler", "parse.ts"), "utf-8"
        );
        expect(content).toBe("export function parse() {}");
    });

    test("non-fs claims (e.g. port:) are silently skipped", async () => {
        const aperturePath = await engine.openAperture({
            taskId: "port-claim",
            claims: ["port:8080", "fs:config"],
            projectRoot: testProjectRoot,
        });
        openedApertures.push(aperturePath);

        // Only fs: claims should be projected
        const configExists = await fs.lstat(path.join(aperturePath, "config"))
            .then(() => true).catch(() => false);
        expect(configExists).toBe(true);

        // The aperture should exist (not error on non-fs claims)
        const apExists = await fs.lstat(aperturePath)
            .then(() => true).catch(() => false);
        expect(apExists).toBe(true);
    });
});
