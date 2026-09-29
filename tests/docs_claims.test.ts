/**
 * Tests: documentation claims audit.
 *
 * This repository has repeatedly shipped documentation asserting things the code
 * did not do — a failure sandbox that was never implemented, a `b4mal login`
 * command that does not exist, a `providesEnv` injection mechanism with no code
 * behind it, `.b4mal/artifacts/` for a vault that lives in the home directory,
 * and a benchmark page claiming 35/35 GREEN when the real figure was 34/35.
 *
 * Prose review does not scale and does not survive. These checks are mechanical:
 * they read the docs and the source and fail when the two disagree, so drift is
 * caught by `bun test` (and therefore by CI) rather than by a reader.
 *
 * When a check fails, the fix is usually to correct the documentation. If a
 * feature has genuinely been implemented, update the doc — and if you are adding
 * something to an allowlist here, write down why.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const DOCS = join(ROOT, "docs");

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Every .md file under docs/, plus the repo-root markdown that ships. */
function markdownFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry === ".vitepress") continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith(".md")) out.push(full);
        }
    };
    walk(DOCS);
    for (const f of ["README.md", "ARCHITECTURE.md", "BENCHMARKS.md", "COVERAGE.md", "ROADMAP.md"]) {
        const full = join(ROOT, f);
        if (existsSync(full)) out.push(full);
    }
    return out;
}

/** All .ts source under src/, excluding tests. */
function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith(".ts")) out.push(full);
        }
    };
    walk(SRC);
    return out;
}

function readAll(files: string[]): { file: string; text: string }[] {
    return files.map(file => ({ file: relative(ROOT, file), text: readFileSync(file, "utf-8") }));
}

/** Subcommands the CLI actually implements. */
function implementedCommands(): Set<string> {
    const cli = readFileSync(join(SRC, "cli/index.ts"), "utf-8");
    const commands = new Set<string>();
    for (const m of cli.matchAll(/case\s+"([a-z][a-z0-9-]*)":/g)) commands.add(m[1]);
    return commands;
}

// ─── CLI commands referenced in docs ────────────────────────────────────────

describe("docs claims: CLI commands", () => {
    /**
     * Tokens that appear after `b4mal` in a command position but are not
     * subcommands. Each entry needs a reason:
     *
     *  - lock / config / json / ts  — file names (`b4mal.lock`, `b4mal.config.json`)
     *  - login                      — named only to say the command does NOT exist
     */
    const NOT_COMMANDS = new Set(["lock", "config", "json", "ts", "login"]);

    /**
     * Command-position text only: inline code spans and fenced code blocks.
     * Scanning raw prose matches sentences like "b4mal vs. Turborepo".
     */
    function commandPositions(text: string): string[] {
        const out: string[] = [];
        for (const m of text.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
        for (const m of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) out.push(m[1]);
        return out;
    }

    test("every `b4mal <subcommand>` in the docs is implemented", () => {
        const commands = implementedCommands();
        const unknown: string[] = [];

        for (const { file, text } of readAll(markdownFiles())) {
            for (const snippet of commandPositions(text)) {
                for (const m of snippet.matchAll(/\bb4mal\s+([a-z][a-z0-9-]*)/g)) {
                    const word = m[1];
                    if (NOT_COMMANDS.has(word) || commands.has(word)) continue;
                    // Only flag things that look like a subcommand invocation:
                    // the token is the last word, or followed by a flag/argument.
                    if (!/(\s|$)/.test(snippet.slice(m.index! + m[0].length, m.index! + m[0].length + 1) || " ")) continue;
                    unknown.push(`${file}: b4mal ${word}`);
                }
            }
        }

        expect(unknown).toEqual([]);
    });

    test("the implemented command set is non-trivial (parser sanity)", () => {
        // Guards against the extraction silently returning nothing, which would
        // make the check above pass vacuously.
        const commands = implementedCommands();
        expect(commands.has("build")).toBe(true);
        expect(commands.has("check")).toBe(true);
        expect(commands.size).toBeGreaterThanOrEqual(10);
    });

    test("the command-position extractor finds real snippets (parser sanity)", () => {
        // If this returns nothing the command check is vacuous.
        const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
        const positions = commandPositions(readme);
        expect(positions.length).toBeGreaterThan(5);
        expect(positions.some(p => /b4mal\s+(build|check)/.test(p))).toBe(true);
    });
});

// ─── Documented configuration fields ────────────────────────────────────────

describe("docs claims: configuration fields", () => {
    test("every field in the configuration table exists in the schema", () => {
        const configDoc = readFileSync(join(DOCS, "guide/configuration.md"), "utf-8");
        const schema = readFileSync(join(SRC, "schema.ts"), "utf-8");

        // First column of each table row: | `fieldName` | TYPE | ...
        const documented = new Set<string>();
        for (const line of configDoc.split("\n")) {
            const m = line.match(/^\|\s*`([a-zA-Z_][a-zA-Z0-9_]*)`\s*\|/);
            if (m) documented.add(m[1]);
        }

        expect(documented.size).toBeGreaterThan(5); // parser sanity

        const missing = [...documented].filter(field => !new RegExp(`\\b${field}\\s*:`).test(schema));
        expect(missing).toEqual([]);
    });
});

// ─── Links ──────────────────────────────────────────────────────────────────

describe("docs claims: links", () => {
    test("internal doc routes resolve to a real page", () => {
        const broken: string[] = [];

        for (const { file, text } of readAll(markdownFiles())) {
            for (const m of text.matchAll(/\]\((\/[A-Za-z0-9/_-]*)\)/g)) {
                const route = m[1].replace(/^\//, "").replace(/\/$/, "");
                if (route === "") continue; // site root
                const candidates = [
                    join(DOCS, `${route}.md`),
                    join(DOCS, route, "index.md"),
                ];
                if (!candidates.some(existsSync)) broken.push(`${file}: ${m[1]}`);
            }
        }

        expect(broken).toEqual([]);
    });

    test("no link points at the wrong GitHub owner", () => {
        // The docs home page shipped `github.com/b4mal/b4mal`, which is not this
        // repository. Cheap to reintroduce by copy-paste; cheap to catch here.
        const offenders: string[] = [];
        for (const { file, text } of readAll([...markdownFiles(), ...sourceFiles()])) {
            if (text.includes("github.com/b4mal/")) offenders.push(file);
        }
        expect(offenders).toEqual([]);
    });

    test("external links use a known host", () => {
        // Adding a host here is a deliberate act: it should be a domain that
        // actually resolves and that we intend to depend on.
        const ALLOWED_HOSTS = new Set([
            "github.com",
            "raw.githubusercontent.com",
            "bun.sh",
            "example.com",
            "www.npmjs.com",
            "registry.npmjs.org",
        ]);

        const offenders: string[] = [];
        for (const { file, text } of readAll(markdownFiles())) {
            for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
                const host = new URL(m[1]).host;
                if (!ALLOWED_HOSTS.has(host)) offenders.push(`${file}: ${host}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

// ─── The dead domain ────────────────────────────────────────────────────────

describe("docs claims: no references to an unregistered domain", () => {
    test("b4mal.dev does not appear in source, docs or installer", () => {
        // b4mal.dev is NXDOMAIN. CLI error messages, the LSP, the docs and
        // install.sh all used to send users there. artifacts/ is excluded: those
        // are dated planning records, not user-facing documentation.
        const targets = [
            ...markdownFiles(),
            ...sourceFiles(),
            join(ROOT, "install.sh"),
            join(ROOT, "package.json"),
        ].filter(f => !f.includes("artifacts/"));

        const offenders = readAll(targets)
            .filter(({ text }) => text.includes("b4mal.dev"))
            .map(({ file }) => file);

        expect(offenders).toEqual([]);
    });
});

// ─── Claims that have already been false once ───────────────────────────────

describe("docs claims: banned overclaim phrasing", () => {
    /**
     * Phrases that were shipped as headlines and were not true at the time.
     *
     * These are banned as *unsourced slogans*, not because the underlying facts are
     * impossible — the benchmark result is now genuinely 35/35 (see
     * docs/guide/benchmark-results.md). The failure mode being guarded against is
     * asserting a result instead of measuring it: the same sentence was on the page
     * when the measured figure was 34/35 and 51% functional.
     *
     * So: state measured values in a table, next to the command that reproduces
     * them. Do not assert the slogan.
     *
     *  - "mathematically proven" / "formally proves"  — path-disjointness is a
     *    decidable check over *declared* claims; undeclared access defeats it.
     *  - "cryptographically proves" / "signed proof"  — the attestation is an
     *    unkeyed SHA-256 digest; the signature field is an explicit placeholder.
     *  - "provably correct"                           — cache correctness is
     *    conditional on complete declarations.
     *  - "100% GREEN" / "zero placeholders"           — headline forms of a
     *    benchmark result; report the numbers instead.
     *  - "Real-Time Dashboard"                        — the TUI HUD is not wired
     *    into the CLI; `analyze` writes a static HTML report.
     *  - "cryptographic verification at every layer"   — the remote cache is
     *    unauthenticated: pushes send signature:null and pulls never verify it.
     */
    const BANNED = [
        /mathematically\s+proven/i,
        /formally\s+proves/i,
        /cryptographically\s+proves?/i,
        /signed\s+proof/i,
        /provably\s+correct/i,
        /100%\s*GREEN/i,
        /zero\s+placeholders/i,
        /Real-Time\s+Dashboard/i,
        /cryptographic\s+verification\s+at\s+every\s+layer/i,
    ];

    test("docs do not assert claims that were previously false", () => {
        const offenders: string[] = [];
        for (const { file, text } of readAll(markdownFiles())) {
            for (const pattern of BANNED) {
                const hit = text.match(pattern);
                if (hit) offenders.push(`${file}: "${hit[0]}"`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

// ─── "Not Yet Implemented" must stay true in both directions ────────────────

describe("docs claims: unimplemented features", () => {
    test("features the README says are missing really are missing", () => {
        const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
        expect(readme).toMatch(/Not Yet Implemented/i);

        // If any of these strings appears in src/, the feature has been built and
        // the README section is now wrong — update the docs.
        const unimplemented = [".b4mal/shadow", "BuildDoctor"];
        const sources = readAll(sourceFiles());

        for (const marker of unimplemented) {
            const implementedIn = sources
                .filter(({ text }) => text.includes(marker))
                .map(({ file }) => file);
            expect(implementedIn).toEqual([]);
        }
    });

    test("the failure sandbox is documented as absent", () => {
        // The single most-repeated false claim in this repo: four files described
        // clone-on-failure sandboxing that never existed.
        const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
        expect(readme).toMatch(/failure sandboxing/i);
        expect(readme).toMatch(/not implemented/i);
    });
});
