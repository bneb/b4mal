/**
 * Tests: CLI version resolution.
 *
 * `--version` and `--help` are the two most basic invocations, and both used to
 * crash on the BUILT artifact because they read the version from a fixed
 * `../../package.json` relative to the module's own directory. From `src/cli/`
 * that resolves to the repo root; from `dist/` it resolves to the *parent* of
 * the repo, which does not exist — an ENOENT that surfaced as an unhandled
 * rejection and exit 1.
 */
import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getVersion, FALLBACK_VERSION } from "../src/cli/version";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_SRC = join(REPO_ROOT, "src/cli/index.ts");
const DIST_ENTRY = join(REPO_ROOT, "dist/index.js");

let scratch: string | undefined;

// `dist/` is gitignored, so a fresh CI checkout has no bundle — and CI's Dogfood
// job runs `bun test` BEFORE its build step. The bundled layout is precisely what
// regressed here, so build it on demand rather than skipping these tests.
beforeAll(async () => {
    if (existsSync(DIST_ENTRY)) return;

    const proc = Bun.spawn(
        ["bun", "build", CLI_SRC, "--outdir", join(REPO_ROOT, "dist"), "--target", "bun"],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`could not build dist/ for these tests: ${stderr}`);
    }
}, 120000);

afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
});

function packageVersion(): string {
    return JSON.parse(require("fs").readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).version;
}

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

describe("CLI --version / --help from every layout", () => {
    test("works from the source entry point", async () => {
        const result = await runCli(CLI_SRC, "--version", REPO_ROOT);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(packageVersion());
    });

    test("works from the bundled dist entry point (the original crash)", async () => {
        const result = await runCli(DIST_ENTRY, "--version", REPO_ROOT);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout.trim()).toBe(packageVersion());
    });

    test("--help works from the bundled dist entry point", async () => {
        const result = await runCli(DIST_ENTRY, "--help", REPO_ROOT);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout).toMatch(/Usage:/);
        expect(result.stdout).toMatch(/Build Engine v\d+\.\d+\.\d+/);
    });

    test("works from a global-install layout", async () => {
        // Mimic <prefix>/node_modules/b4mal/dist/index.js with a package.json
        // two levels up.
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-"));
        const pkgDir = join(scratch, "node_modules", "b4mal");
        mkdirSync(join(pkgDir, "dist"), { recursive: true });
        cpSync(DIST_ENTRY, join(pkgDir, "dist/index.js"));

        const pkgPath = join(REPO_ROOT, "package.json");
        cpSync(pkgPath, join(pkgDir, "package.json"));

        const result = await runCli(join(pkgDir, "dist/index.js"), "--version", scratch!);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(packageVersion());
    });

    test("still works when package.json cannot be found at all", async () => {
        // No package.json anywhere above the entry: the compiled-in fallback
        // must be used rather than crashing.
        scratch = mkdtempSync(join(tmpdir(), "b4mal-version-orphan-"));
        const orphan = join(scratch, "dist");
        mkdirSync(orphan, { recursive: true });
        cpSync(DIST_ENTRY, join(orphan, "index.js"));

        const result = await runCli(join(orphan, "index.js"), "--version", scratch!);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toMatch(/UNHANDLED REJECTION/);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
});
