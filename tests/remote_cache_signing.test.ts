/**
 * Tests: remote cache integrity (L2 signing).
 *
 * The remote cache was unauthenticated: pushes sent `signature: null`, pulls
 * never read the field, and src/core/crypto.ts — which already implemented
 * HMAC-SHA256 signing with a B4MAL_CACHE_SECRET env var — was imported by
 * nothing. Anything able to write to the bucket could therefore influence
 * workspace contents.
 *
 * These tests drive the real CLI against the in-memory S3 stub and prove the
 * three properties that matter:
 *
 *   1. a signed artifact round-trips when the secret matches
 *   2. a tampered payload is rejected, and the task re-executes instead
 *   3. a validly signed artifact cannot be replayed under another task's key
 *
 * Rejection is not a build failure: the artifact is treated as a miss, so the
 * task simply runs. That is the point — refusing to restore is the safe outcome.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { startS3Stub, type S3Stub } from "./fixtures/s3_stub";
import { ArtifactVault } from "../src/core/artifact_vault";
import { ArtifactCrypto } from "../src/core/crypto";

const CLI = join(import.meta.dir, "../src/cli/index.ts");
const BUCKET = "b4mal-test";
const SECRET = "test-signing-secret";

let stub: S3Stub;
let projectDir: string;

function localVaultDir(): string {
    return dirname(ArtifactVault.getArchivePath("probe", projectDir));
}

function wipeL1(): void {
    rmSync(join(projectDir, ".b4mal"), { recursive: true, force: true });
    rmSync(localVaultDir(), { recursive: true, force: true });
}

/** Run one task by name so the two fixtures can be built independently. */
async function buildTask(taskId: string, env: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", CLI, "build", "--force"], {
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
    return { exitCode, output, cacheHits: Number(/(\d+) cache hits/.exec(output)?.[1] ?? "-1") };
}

/** Run the whole graph without --force, the way a CI runner would. */
async function build(env: Record<string, string> = {}) {
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
    return { exitCode, output, cacheHits: Number(/(\d+) cache hits/.exec(output)?.[1] ?? "-1") };
}

/** The single object key the stub holds for a given prefix, if any. */
function onlyKey(): string {
    const keys = [...stub.objects.keys()];
    expect(keys).toHaveLength(1);
    return keys[0];
}

beforeEach(() => {
    stub = startS3Stub();
    projectDir = mkdtempSync(join(tmpdir(), "b4mal-l2sig-"));
    writeFileSync(join(projectDir, "b4mal.config.json"), JSON.stringify({
        tasks: {
            gen: {
                cmd: ["sh", "-c", "mkdir -p out && echo signed-payload > out/a.txt"],
                outputs: ["out/a.txt"],
            },
        },
    }, null, 2));
});

afterEach(() => {
    stub?.stop();
    if (projectDir) {
        try { rmSync(localVaultDir(), { recursive: true, force: true }); } catch { /* best effort */ }
        rmSync(projectDir, { recursive: true, force: true });
    }
});

// ─── ArtifactCrypto unit behaviour ──────────────────────────────────────────

describe("ArtifactCrypto", () => {
    test("with no secret it runs in trust mode", () => {
        const crypto = new ArtifactCrypto(null);
        expect(crypto.isEnabled).toBe(false);
        expect(crypto.sign("anything")).toBeNull();
        expect(crypto.verify("anything", undefined)).toBe(true);
    });

    test("an empty secret is treated as unset, not as a key", () => {
        const crypto = new ArtifactCrypto("");
        expect(crypto.isEnabled).toBe(false);
        expect(crypto.verify("anything", undefined)).toBe(true);
    });

    test("a configured secret round-trips and rejects mismatches", () => {
        const crypto = new ArtifactCrypto(SECRET);
        const signature = crypto.sign("payload-hash")!;
        expect(signature).toHaveLength(64);
        expect(crypto.verify("payload-hash", signature)).toBe(true);
        expect(crypto.verify("other-hash", signature)).toBe(false);
        expect(crypto.verify("payload-hash", undefined)).toBe(false);
        expect(crypto.verify("payload-hash", "deadbeef")).toBe(false);
        expect(crypto.verify("payload-hash", signature.slice(0, -1) + "0")).toBe(false);
    });

    test("a different secret produces a different signature", () => {
        const a = new ArtifactCrypto("secret-a").sign("payload")!;
        const b = new ArtifactCrypto("secret-b").sign("payload")!;
        expect(a).not.toBe(b);
    });
});

// ─── Signed round trip ──────────────────────────────────────────────────────

describe("signed remote cache — matching secret", () => {
    test("pushes a signature and restores from the remote", async () => {
        const cold = await buildTask("gen", { B4MAL_CACHE_SECRET: SECRET });
        expect(cold.exitCode).toBe(0);
        expect(stub.objects.size).toBe(1);

        // The stored object must carry a real signature now.
        const stored = stub.objects.get(onlyKey())!;
        const headerLen = new DataView(stored.buffer, stored.byteOffset).getUint32(0, true);
        const metadata = JSON.parse(new TextDecoder().decode(stored.subarray(4, 4 + headerLen)));
        expect(metadata.signature).toMatch(/^[a-f0-9]{64}$/);

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const warm = await build({ B4MAL_CACHE_SECRET: SECRET });
        expect(warm.exitCode).toBe(0);
        expect(warm.cacheHits).toBe(1);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("signed-payload\n");
        expect(warm.output).not.toMatch(/rejected artifact/);
    });
});

// ─── Tampering ──────────────────────────────────────────────────────────────

describe("signed remote cache — tampered artifact", () => {
    test("rejects a modified payload and re-executes instead", async () => {
        await buildTask("gen", { B4MAL_CACHE_SECRET: SECRET });
        const key = onlyKey();

        // Flip a byte inside the compressed payload, leaving the metadata header
        // intact so this fails signature verification rather than parsing.
        const stored = stub.objects.get(key)!;
        const headerLen = new DataView(stored.buffer, stored.byteOffset).getUint32(0, true);
        const tampered = new Uint8Array(stored);
        const target = 4 + headerLen + 1;
        tampered[target] = tampered[target] ^ 0xff;
        stub.objects.set(key, tampered);

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build({ B4MAL_CACHE_SECRET: SECRET });

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/rejected artifact/);
        expect(result.cacheHits).toBe(0);           // the hit was refused
        // ...and the task re-executed, producing its own correct output.
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("signed-payload\n");
    });

    test("rejects an artifact whose metadata was edited after signing", async () => {
        // The payload and metadata are signed together. Without that, the header
        // would be a place to write unauthenticated data: exitCode and durationMs
        // are read back on a pull and reported as the task's result, so an editor
        // with bucket access could change them while leaving the payload — and a
        // payload-only signature — untouched.
        await buildTask("gen", { B4MAL_CACHE_SECRET: SECRET });
        const key = onlyKey();

        const stored = stub.objects.get(key)!;
        const view = new DataView(stored.buffer, stored.byteOffset);
        const headerLen = view.getUint32(0, true);
        const metadata = JSON.parse(new TextDecoder().decode(stored.subarray(4, 4 + headerLen)));
        expect(metadata.exitCode).toBe(0);

        // Re-encode the header with a different exit code, payload unchanged.
        metadata.exitCode = 42;
        const newHeader = new TextEncoder().encode(JSON.stringify(metadata));
        const lengthPrefix = new Uint8Array(4);
        new DataView(lengthPrefix.buffer).setUint32(0, newHeader.length, true);
        const payloadBytes = stored.subarray(4 + headerLen);

        const tampered = new Uint8Array(4 + newHeader.length + payloadBytes.length);
        tampered.set(lengthPrefix, 0);
        tampered.set(newHeader, 4);
        tampered.set(payloadBytes, 4 + newHeader.length);
        stub.objects.set(key, tampered);

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build({ B4MAL_CACHE_SECRET: SECRET });

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/rejected artifact/);
        // Not 42: the tampered metadata never reached the build.
        expect(result.output).not.toMatch(/exit 42/);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("signed-payload\n");
    });

    test("rejects an artifact when the secret does not match", async () => {
        await buildTask("gen", { B4MAL_CACHE_SECRET: SECRET });
        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build({ B4MAL_CACHE_SECRET: "a-different-secret" });

        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/rejected artifact/);
        expect(result.cacheHits).toBe(0);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("signed-payload\n");
    });
});

// ─── Replay across keys ─────────────────────────────────────────────────────

describe("signed remote cache — replay under a different key", () => {
    test("a validly signed artifact is not accepted for another task", async () => {
        // Two tasks, so two keys with two valid signatures.
        writeFileSync(join(projectDir, "b4mal.config.json"), JSON.stringify({
            tasks: {
                genA: { cmd: ["sh", "-c", "mkdir -p out && echo A-content > out/a.txt"], outputs: ["out/a.txt"] },
                genB: { cmd: ["sh", "-c", "mkdir -p out && echo B-content > out/b.txt"], outputs: ["out/b.txt"] },
            },
        }, null, 2));

        const cold = await build({ B4MAL_CACHE_SECRET: SECRET, });
        expect(cold.exitCode).toBe(0);
        expect(stub.objects.size).toBe(2);

        const [keyA, keyB] = [...stub.objects.keys()].sort();
        // Serve A's (validly signed) artifact under B's key.
        stub.objects.set(keyB, stub.objects.get(keyA)!);

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const result = await build({ B4MAL_CACHE_SECRET: SECRET });

        expect(result.exitCode).toBe(0);
        // B was refused: the signature is bound to the logic hash, so A's
        // artifact cannot stand in for B's.
        expect(result.output).toMatch(/rejected artifact/);
        // Both tasks re-executed, so both outputs are their own.
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("A-content\n");
        expect(readFileSync(join(projectDir, "out/b.txt"), "utf-8")).toBe("B-content\n");
    });
});

// ─── Unsigned mode is unchanged ─────────────────────────────────────────────

describe("unsigned remote cache", () => {
    test("with no secret, entries are stored unsigned and still restored", async () => {
        const cold = await buildTask("gen");   // no B4MAL_CACHE_SECRET
        expect(cold.exitCode).toBe(0);

        const stored = stub.objects.get(onlyKey())!;
        const headerLen = new DataView(stored.buffer, stored.byteOffset).getUint32(0, true);
        const metadata = JSON.parse(new TextDecoder().decode(stored.subarray(4, 4 + headerLen)));
        expect(metadata.signature).toBeNull();

        wipeL1();
        rmSync(join(projectDir, "out"), { recursive: true, force: true });

        const warm = await build();
        expect(warm.cacheHits).toBe(1);
        expect(readFileSync(join(projectDir, "out/a.txt"), "utf-8")).toBe("signed-payload\n");
    });
});
