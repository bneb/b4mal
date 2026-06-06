// tests/artifact_vault.test.ts — v4.2.0 "The Artifact Vault" (RED-to-GREEN)

import { describe, test, expect, afterAll } from "bun:test";
import { ArtifactVault } from "../src/core/artifact_vault";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════
// § 1 — Pack / Unpack Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe("ArtifactVault — Pack & Unpack", () => {
    const testDirs: string[] = [];

    afterAll(async () => {
        for (const d of testDirs) {
            await fs.rm(d, { recursive: true, force: true }).catch(() => { });
        }
    });

    test("pack then unpack restores exact file contents", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-vault-test-" + Date.now());
        testDirs.push(projectRoot);
        await fs.mkdir(path.join(projectRoot, "build"), { recursive: true });

        const originalContent = "compiled output — " + Math.random();
        await fs.writeFile(path.join(projectRoot, "build", "output.txt"), originalContent);

        const logicHash = "pack_unpack_test_" + Date.now();

        // Pack
        await ArtifactVault.pack(logicHash, projectRoot, ["build/"]);

        // Delete the file — simulates a clean workspace
        await fs.rm(path.join(projectRoot, "build"), { recursive: true, force: true });

        // Confirm it's gone
        const exists = await fs.access(path.join(projectRoot, "build", "output.txt")).then(() => true).catch(() => false);
        expect(exists).toBe(false);

        // Unpack — should restore
        await ArtifactVault.unpack(logicHash, projectRoot);

        // Verify exact content
        const restored = await fs.readFile(path.join(projectRoot, "build", "output.txt"), "utf-8");
        expect(restored).toBe(originalContent);

        // Cleanup vault artifact
        await ArtifactVault.remove(logicHash, projectRoot);
    });

    test("pack preserves nested directory structures", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-vault-nested-" + Date.now());
        testDirs.push(projectRoot);
        await fs.mkdir(path.join(projectRoot, "dist", "js"), { recursive: true });
        await fs.mkdir(path.join(projectRoot, "dist", "css"), { recursive: true });

        await fs.writeFile(path.join(projectRoot, "dist", "js", "app.js"), "console.log('app')");
        await fs.writeFile(path.join(projectRoot, "dist", "css", "style.css"), "body { }");

        const logicHash = "nested_test_" + Date.now();

        await ArtifactVault.pack(logicHash, projectRoot, ["dist/"]);
        await fs.rm(path.join(projectRoot, "dist"), { recursive: true, force: true });
        await ArtifactVault.unpack(logicHash, projectRoot);

        const js = await fs.readFile(path.join(projectRoot, "dist", "js", "app.js"), "utf-8");
        const css = await fs.readFile(path.join(projectRoot, "dist", "css", "style.css"), "utf-8");
        expect(js).toBe("console.log('app')");
        expect(css).toBe("body { }");

        await ArtifactVault.remove(logicHash, projectRoot);
    });

    test("pack with multiple write paths archives all of them", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-vault-multi-" + Date.now());
        testDirs.push(projectRoot);
        await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });

        await fs.writeFile(path.join(projectRoot, "out", "a.bin"), "aaa");
        await fs.writeFile(path.join(projectRoot, "out", "b.bin"), "bbb");

        const logicHash = "multi_test_" + Date.now();

        await ArtifactVault.pack(logicHash, projectRoot, ["out/a.bin", "out/b.bin"]);
        await fs.rm(path.join(projectRoot, "out"), { recursive: true, force: true });
        await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });
        await ArtifactVault.unpack(logicHash, projectRoot);

        const a = await fs.readFile(path.join(projectRoot, "out", "a.bin"), "utf-8");
        const b = await fs.readFile(path.join(projectRoot, "out", "b.bin"), "utf-8");
        expect(a).toBe("aaa");
        expect(b).toBe("bbb");

        await ArtifactVault.remove(logicHash, projectRoot);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// § 2 — Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe("ArtifactVault — Edge Cases", () => {
    test("empty writes array resolves without error", async () => {
        // Must not spawn a broken tar command
        await expect(
            ArtifactVault.pack("empty_test", "/tmp", [])
        ).resolves.toBeUndefined();
    });

    test("unpack non-existent archive throws a clear error", async () => {
        await expect(
            ArtifactVault.unpack("this_hash_does_not_exist_" + Date.now(), "/tmp")
        ).rejects.toThrow("Artifact archive not found");
    });

    test("hasArtifact returns true for packed, false for missing", async () => {
        const projectRoot = path.join(os.tmpdir(), "b4mal-vault-has-" + Date.now());
        await fs.mkdir(projectRoot, { recursive: true });
        await fs.writeFile(path.join(projectRoot, "marker.txt"), "x");

        const logicHash = "has_test_" + Date.now();

        expect(ArtifactVault.hasArtifact(logicHash, projectRoot)).toBe(false);

        await ArtifactVault.pack(logicHash, projectRoot, ["marker.txt"]);
        expect(ArtifactVault.hasArtifact(logicHash, projectRoot)).toBe(true);

        await ArtifactVault.remove(logicHash, projectRoot);
        expect(ArtifactVault.hasArtifact(logicHash, projectRoot)).toBe(false);

        await fs.rm(projectRoot, { recursive: true, force: true });
    });
});
