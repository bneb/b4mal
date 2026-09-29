/**
 * Tests: L2 remote cache, end to end.
 *
 * The remote cache is the feature most likely to disappoint a new user — it is
 * advertised as sharing artifacts across CI runners, and until now nothing
 * exercised it: the existing unit tests mock the adapter, and the live path had
 * never been run because it needs credentials.
 *
 * These tests drive the real CLI against a real (local, in-memory)
 * S3-compatible endpoint. No credentials, no network, no Docker. The key
 * technique: L1 is wiped between runs, so a second-run cache hit can only have
 * been served by L2, and whether the task's files were actually restored is
 * unambiguous.
 *
 * That is how the following was found: an L2 hit reported success and a cache
 * hit while the declared outputs were absent from the workspace, because
 * checkAndPull promoted the archive into the local vault without ever
 * extracting it.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { startS3Stub, type S3Stub } from "./fixtures/s3_stub";
import { ArtifactVault } from "../src/core/artifact_vault";

const CLI = join(import.meta.dir, "../src/cli/index.ts");
const BUCKET = "b4mal-test";

let stub: S3Stub;
let projectDir: string;

/** This project's directory inside the local artifact vault (~/.b4mal/artifacts/<hash>). */
function localVaultDir(): string {
    return dirname(ArtifactVault.getArchivePath("probe", projectDir));
}

/** Remove L1 entirely: the ledger and this project's local vault. */
function wipeL1(): void {
    rmSync(join(projectDir, ".b4mal"), { recursive: true, force: true });
    rmSync(localVaultDir(), { recursive: true, force: true });
}

interface RunResult {
    exitCode: number;
    output: string;
    cacheHits: number;
}

async function build(env: Record<string, string> = {}): Promise<RunResult> {
    const proc = Bun.spawn(["bun", CLI, "build"], {
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
            ...env,
        },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    const output = stdout + stderr;
    const cacheHits = Number(/(\d+) cache hits/.exec(output)?.[1] ?? "-1");
    return { exitCode, output, cacheHits };
}

beforeAll(() => {
    stub = startS3Stub();
    projectDir = mkdtempSync(join(tmpdir(), "b4mal-l2-"));
    writeFileSync(join(projectDir, "b4mal.config.json"), JSON.stringify({
        tasks: {
            gen: {
                cmd: ["sh", "-c", "mkdir -p out && echo l2-payload > out/a.txt"],
                outputs: ["out/a.txt"],
            },
        },
    }, null, 2));
});

afterAll(() => {
    stub?.stop();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    // Leave no vault directory behind for a deleted temp project.
    try { rmSync(localVaultDir(), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("L2 remote cache — cold run", () => {
    test("executes the task and pushes the artifact to the remote", async () => {
        wipeL1();
        const result = await build();

        expect(result.exitCode).toBe(0);
        expect(result.cacheHits).toBe(0); // cold: nothing to hit
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("l2-payload\n");

        const keys = [...stub.objects.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(new RegExp(`^${BUCKET}/b4mal/[a-f0-9]{64}\\.tar\\.zst$`));
        expect(stub.requests.some(r => r.method === "PUT")).toBe(true);
    });
});

describe("L2 remote cache — warm run with L1 wiped", () => {
    test("restores the declared outputs from the remote", async () => {
        // Precondition: the remote holds the artifact from the cold run, and L1
        // is empty, so only the remote can satisfy this build.
        expect(stub.objects.size).toBe(1);
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(false);

        const before = stub.requests.length;
        const result = await build();

        expect(result.exitCode).toBe(0);
        expect(result.cacheHits).toBe(1);

        // The remote was actually consulted...
        const during = stub.requests.slice(before).map(r => r.method);
        expect(during).toContain("HEAD");
        expect(during).toContain("GET");

        // ...and, the point of the whole feature, the files came back.
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(true);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("l2-payload\n");
    });

    test("a second warm run also restores, rather than reporting a hit with no files", async () => {
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build();

        expect(result.cacheHits).toBe(1);
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(true);
    });
});

describe("L2 remote cache — failure handling", () => {
    test("an unreachable remote is non-fatal: the build still executes", async () => {
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        // Port 1 refuses connections.
        const result = await build({ AWS_S3_ENDPOINT: "http://127.0.0.1:1" });

        expect(result.exitCode).toBe(0);
        expect(existsSync(join(projectDir, "out/a.txt"))).toBe(true);
        expect(result.cacheHits).toBe(0);
    });

    test("without L2 configured the build is unaffected", async () => {
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build({
            B4MAL_CACHE_BUCKET: "",
            AWS_ACCESS_KEY_ID: "",
            AWS_SECRET_ACCESS_KEY: "",
        });

        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("l2-payload\n");
    });

    test("a warm L1 still works after the remote has been used", async () => {
        // Guards against the L2 change disturbing the L1 path.
        const first = await build();   // may hit L2 or L1
        expect(first.exitCode).toBe(0);
        const second = await build();  // now definitely warm locally too
        expect(second.exitCode).toBe(0);
        expect(second.cacheHits).toBe(1);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("l2-payload\n");
    });
});
