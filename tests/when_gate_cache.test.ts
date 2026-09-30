/**
 * Tests: `when` gates are evaluated before the caches, not after.
 *
 * A task's cache key is its command plus declared inputs. It does not include
 * `when`, so the same task gated differently on two machines shares one key. With
 * the gate evaluated *after* the cache lookups — where it used to sit — a Linux CI
 * runner would populate L2 for a task marked `platform: ["linux"]`, and a macOS
 * developer pulling that entry would have it restored rather than skipped:
 * success reported, and outputs written that should not exist on that machine.
 *
 * The platform gate is exercised with a value that excludes the current platform,
 * so the test behaves identically on every OS.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { startS3Stub, type S3Stub } from "./fixtures/s3_stub";
import { ArtifactVault } from "../src/core/artifact_vault";

const CLI = join(import.meta.dir, "../src/cli/index.ts");
const BUCKET = "b4mal-test";

/** A platform this machine is not. */
const OTHER_PLATFORM = process.platform === "linux" ? "darwin" : "linux";

let stub: S3Stub;
let projectDir: string;

function localVaultDir(): string {
    return dirname(ArtifactVault.getArchivePath("probe", projectDir));
}

function wipeL1(): void {
    rmSync(join(projectDir, ".b4mal"), { recursive: true, force: true });
    rmSync(localVaultDir(), { recursive: true, force: true });
}

function writeConfig(gatedPlatform: string | null): void {
    writeFileSync(join(projectDir, "b4mal.config.json"), JSON.stringify({
        tasks: {
            gen: {
                cmd: ["sh", "-c", "mkdir -p out && echo gated-payload > out/a.txt"],
                outputs: ["out/a.txt"],
                ...(gatedPlatform ? { when: { platform: [gatedPlatform] } } : {}),
            },
        },
    }, null, 2));
}

async function build() {
    const proc = Bun.spawn(["bun", CLI, "build", "--sync"], {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            B4MAL_CACHE_BUCKET: BUCKET,
            AWS_ACCESS_KEY_ID: "test",
            AWS_SECRET_ACCESS_KEY: "test",
            AWS_REGION: "us-east-1",
            AWS_S3_ENDPOINT: stub.url,
        },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const output = stdout + stderr;
    return { exitCode, output, cacheHits: Number(/(\d+) cache hits/.exec(output)?.[1] ?? "-1") };
}

beforeEach(() => {
    stub = startS3Stub();
    projectDir = mkdtempSync(join(tmpdir(), "b4mal-when-"));
});

afterEach(() => {
    stub?.stop();
    if (projectDir) {
        try { rmSync(localVaultDir(), { recursive: true, force: true }); } catch { /* best effort */ }
        rmSync(projectDir, { recursive: true, force: true });
    }
});

describe("when gate versus the remote cache", () => {
    test("a task gated to another platform is skipped even when L2 holds its artifact", async () => {
        // Run 1: ungated, so the task executes and pushes to L2 under a key that
        // does not depend on `when`.
        writeConfig(null);
        const cold = await build();
        expect(cold.exitCode).toBe(0);
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(true);
        expect(stub.objects.size).toBe(1);

        // Run 2: the same task, now gated to a platform this machine is not. The
        // logic hash is unchanged, so L2 still has a matching artifact.
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });
        writeConfig(OTHER_PLATFORM);

        const gated = await build();

        expect(gated.exitCode).toBe(0);
        expect(gated.output).toMatch(/skipped/);
        expect(gated.output).not.toMatch(/cached/);
        // The decisive part: the artifact was NOT restored.
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(false);
    });

    test("the same task is restored from L2 when the gate does allow this platform", async () => {
        // The control: proves the assertion above is about the gate, not about the
        // remote cache being broken.
        writeConfig(null);
        await build();
        expect(stub.objects.size).toBe(1);

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });
        writeConfig(process.platform);

        const allowed = await build();

        expect(allowed.exitCode).toBe(0);
        expect(allowed.cacheHits).toBe(1);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("gated-payload\n");
    });
});
