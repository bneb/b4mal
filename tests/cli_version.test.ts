/**
 * Tests: CLI version resolution.
 *
 * `--version` and `--help` are the two most basic invocations, and both used to
 * crash on the BUILT artifact because they read the version from a fixed
 * `../../package.json` relative to the module's own directory. From `src/cli/`
 * that resolves to the repo root; from `dist/` it resolves to the *parent* of
 * the repo, which does not exist — an ENOENT that surfaced as an unhandled
 * rejection and exit 1.
 *
 * These tests bundle the CLI into a private temporary directory rather than
 * using the repo's `dist/`. That directory is shared with the dogfood test,
 * which runs `b4mal build` — and therefore `bun build --outdir dist` — at the
 * same time, so writing there from here raced with it and made the suite flaky.
 * A private bundle also reproduces the failing layout exactly: the entry point
 * sits one level below its manifest, which is true of `<repo>/dist/index.js`,
 * `<prefix>/node_modules/@bneb/b4mal/dist/index.js`, and the temp copies alike.
 */
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getVersion, FALLBACK_VERSION } from "../src/cli/version";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_SRC = join(REPO_ROOT, "src/cli/index.ts");

/** A version that cannot collide with FALLBACK_VERSION or the real one. */
const SENTINEL_VERSION = "7.7.7-sentinel";

let bundleRoot: string;
let bundleEntry: string;
let scratch: string | undefined;

// Build once, into a private directory: package.json beside a dist/ entry.
beforeAll(async () => {
    bundleRoot = mkdtempSync(join(tmpdir(), "b4mal-bundle-"));
    bundleEntry = join(bundleRoot, "dist", "index.js");

    const proc = Bun.spawn(
        ["bun", "build", CLI_SRC, "--outdir", join(bundleRoot, "dist"), "--target", "bun"],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`could not build the CLI bundle for these tests: ${stderr}`);
    }

    cpSync(join(REPO_ROOT, "package.json"), join(bundleRoot, "package.json"));
}, 120000);

afterAll(() => {
    if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true });
});

afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
});

function packageVersion(): string {
    return JSON.parse(require("fs").readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;
}

/** Write a minimal manifest. */
function writeManifest(dir: string, name: string, version: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2));
}

/**
 * Lay out `<root>/<segments...>/dist/index.js` from the private bundle and
 * return the entry path.
 */
function layOut(root: string, segments: string[], manifest?: { name: string; version: string }): string {
    const pkgDir = join(root, ...segments);
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    cpSync(bundleEntry, join(pkgDir, "dist", "index.js"));
    if (manifest) writeManifest(pkgDir, manifest.name, manifest.version);
    return join(pkgDir, "dist", "index.js");
}

/** Run a CLI entry point and capture stdout/exit code. */
async function runCli(entry: string, flag: string, cwd: string) {
    const proc = Bun.spawn(["bun", entry, flag], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, exitCode };
}

// ─── Version source itself ──────────────────────────────────────────────────

describe("getVersion", () => {
    test("resolves from the source tree", () => {
        expect(getVersion()).toBe(packageVersion());
    });

    test("compiled-in fallback stays in sync with package.json", () => {
        expect(FALLBACK_VERSION).toBe(packageVersion());
    });

    test("never throws", () => {
        expect(() => getVersion()).not.toThrow();
    });
});

// ─── The original crash ─────────────────────────────────────────────────────

describe("CLI --version / --help from bundled layouts", () => {
    test("--version works from a bundle one level below the real manifest", async () => {
        const result = await runCli(bundleEntry, "--version", bundleRoot);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout.trim()).toBe(packageVersion());
    });

    test("--help works from the same bundle", async () => {
        const result = await runCli(bundleEntry, "--help", bundleRoot);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout).toMatch(/Usage:/);
        expect(result.stdout).toMatch(/Build Engine v\d+\.\d+\.\d+/);
    });

    test("works from the source entry point", async () => {
        const result = await runCli(CLI_SRC, "--version", REPO_ROOT);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(packageVersion());
    });
});

// ─── Install layouts ────────────────────────────────────────────────────────
//
// The planted version is deliberately different from FALLBACK_VERSION:
// asserting equality with the real version would pass even if the resolver
// failed to match and silently returned the fallback.
//
// Mutation-checked: reverting version.ts to an exact `name === "b4mal"` match
// makes the scoped and host-manifest tests below fail.

describe("CLI --version across install layouts", () => {
    test("reads the published scoped layout (node_modules/@bneb/b4mal/dist)", async () => {
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-scoped-"));
        const entry = layOut(scratch, ["node_modules", "@bneb", "b4mal"],
            { name: "@bneb/b4mal", version: SENTINEL_VERSION });

        const result = await runCli(entry, "--version", scratch);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(SENTINEL_VERSION);
        expect(result.stdout.trim()).not.toBe(FALLBACK_VERSION);
    });

    test("reads an unscoped layout (node_modules/b4mal/dist)", async () => {
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-unscoped-"));
        const entry = layOut(scratch, ["node_modules", "b4mal"],
            { name: "b4mal", version: SENTINEL_VERSION });

        const result = await runCli(entry, "--version", scratch);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(SENTINEL_VERSION);
    });

    test("ignores an unrelated package.json on the way up", async () => {
        // The resolver must match on the package NAME, not merely take the first
        // package.json it finds — a host project's manifest sits directly above
        // a nested install.
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-host-"));
        writeManifest(scratch, "some-host-app", "3.0.0");

        const entry = layOut(scratch, ["node_modules", "@bneb", "b4mal"],
            { name: "@bneb/b4mal", version: SENTINEL_VERSION });

        const result = await runCli(entry, "--version", scratch);
        expect(result.stdout.trim()).toBe(SENTINEL_VERSION);
        expect(result.stdout.trim()).not.toBe("3.0.0");
    });

    test("degrades to the fallback when no manifest can be found", async () => {
        // No package.json anywhere above the entry: the compiled-in fallback
        // must be used rather than crashing.
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-orphan-"));
        const entry = layOut(scratch, ["dist"]);

        const result = await runCli(entry, "--version", scratch);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout.trim()).toBe(FALLBACK_VERSION);
    });

    test("stops climbing rather than matching a manifest in a parent of the install", async () => {
        // A manifest belonging to something else must never be adopted even when
        // it is the nearest one.
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-nearest-"));
        writeManifest(scratch, "@bneb/not-b4mal", "9.9.9");

        const entry = layOut(scratch, ["dist"]);
        const result = await runCli(entry, "--version", scratch);
        expect(result.stdout.trim()).toBe(FALLBACK_VERSION);
    });
});
