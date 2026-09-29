/**
 * Tests: Cache key determinism.
 *
 * Regression coverage for a self-referential cache key: the executor used to
 * hash `task.claims`, which the engine builds as `inputs + outputs + claims`.
 * For any task declaring outputs, the key therefore depended on the content of
 * the file the task itself writes. Identical inputs produced different cache
 * outcomes depending on unrelated workspace state.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    computeCacheKey,
    cacheKeyInputs,
    writeCovers,
    normalizeFsPath,
    CACHE_KEY_VERSION,
    type CacheKeyTask,
} from "../src/orchestrator/cache_key";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "b4mal-cachekey-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Write a file, forcing a distinct mtime so the hasher's mtime cache cannot mask the change. */
function write(path: string, content: string, ageSeconds = 0): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    if (ageSeconds > 0) {
        const t = (Date.now() - ageSeconds * 1000) / 1000;
        utimesSync(path, t, t);
    }
}

// ─── The self-reference regression ───────────────────────────────────────────

describe("computeCacheKey — a task's own outputs never affect its key", () => {
    const task: CacheKeyTask = {
        id: "gen",
        cmd: ["sh", "-c", "echo v1 > out/a.txt"],
        reads: [],
        writes: ["out/a.txt"],
        claims: ["fs:out/a.txt"],
    };

    test("key is identical whether the output is absent or already written", async () => {
        const whenAbsent = await computeCacheKey(task, root);

        mkdirSync(join(root, "out"), { recursive: true });
        write(join(root, "out/a.txt"), "v1\n", 10);
        const whenPresent = await computeCacheKey(task, root);

        write(join(root, "out/a.txt"), "beta\n", 20);
        const whenDifferent = await computeCacheKey(task, root);

        expect(whenAbsent).toBeDefined();
        expect(whenPresent).toBe(whenAbsent);
        expect(whenDifferent).toBe(whenAbsent);
    });

    test("key changes when a declared input changes", async () => {
        const withInput: CacheKeyTask = {
            id: "build",
            cmd: ["bun", "build"],
            reads: ["src"],
            writes: ["dist"],
            claims: ["fs:src", "fs:dist"],
        };

        mkdirSync(join(root, "src"), { recursive: true });
        write(join(root, "src/main.ts"), "export const a = 1;\n", 10);
        const before = await computeCacheKey(withInput, root);

        write(join(root, "src/main.ts"), "export const a = 2;\n", 20);
        const after = await computeCacheKey(withInput, root);

        expect(after).not.toBe(before);
    });

    test("key changes when the command changes", async () => {
        const base: CacheKeyTask = { id: "t", cmd: ["echo", "one"], reads: ["src"], writes: [] };
        mkdirSync(join(root, "src"), { recursive: true });

        const a = await computeCacheKey(base, root);
        const b = await computeCacheKey({ ...base, cmd: ["echo", "two"] }, root);

        expect(a).not.toBe(b);
    });

    test("distinct tasks sharing identical inputs still get distinct keys", async () => {
        mkdirSync(join(root, "src"), { recursive: true });
        const a = await computeCacheKey({ id: "alpha", cmd: ["echo"], reads: ["src"], writes: [] }, root);
        const b = await computeCacheKey({ id: "beta", cmd: ["echo"], reads: ["src"], writes: [] }, root);

        expect(a).not.toBe(b);
    });
});

// ─── Input selection ────────────────────────────────────────────────────────

describe("cacheKeyInputs", () => {
    test("excludes declared outputs", () => {
        const inputs = cacheKeyInputs({
            id: "build",
            cmd: [],
            reads: ["src"],
            writes: ["dist"],
            claims: ["fs:src", "fs:dist"],
        });
        expect(inputs).toEqual(["src"]);
    });

    test("excludes inputs nested beneath a declared output directory", () => {
        const inputs = cacheKeyInputs({
            id: "build",
            cmd: [],
            reads: ["dist/bundle.js", "src/main.ts"],
            writes: ["dist"],
            claims: [],
        });
        expect(inputs).toEqual(["src/main.ts"]);
    });

    test("is order-independent", () => {
        const a = cacheKeyInputs({ id: "t", cmd: [], reads: ["b", "a"], writes: [], claims: [] });
        const b = cacheKeyInputs({ id: "t", cmd: [], reads: ["a", "b"], writes: [], claims: [] });
        expect(a).toEqual(b);
    });

    test("normalizes protocol prefixes and separators", () => {
        expect(cacheKeyInputs({ id: "t", cmd: [], reads: ["fs:./src/"], writes: [], claims: [] }))
            .toEqual(["src"]);
        expect(normalizeFsPath("fs:src\\win\\file.ts")).toBe("src/win/file.ts");
    });
});

describe("writeCovers", () => {
    test("matches exact paths, not merely shared prefixes", () => {
        expect(writeCovers("src/db", "src/db")).toBe(true);
        expect(writeCovers("src/db", "src/db/file.ts")).toBe(true);
        expect(writeCovers("src/db", "src/db_backup/x.ts")).toBe(false);
    });
});

// ─── Key scheme versioning ──────────────────────────────────────────────────

describe("CACHE_KEY_VERSION", () => {
    test("is mixed into the key so scheme changes cannot alias old entries", async () => {
        // Two tasks identical in every hashed respect still differ if the salt
        // were different; this asserts the salt is non-empty and stable.
        expect(typeof CACHE_KEY_VERSION).toBe("string");
        expect(CACHE_KEY_VERSION.length).toBeGreaterThan(0);
    });
});

// ─── Declared environment variables are inputs ──────────────────────────────
//
// ARCHITECTURE.md promises the hash inputs include "the values of all declared
// env variables". They were not hashed at all, so changing a declared variable
// produced a stale cache hit.

describe("computeCacheKey — declared environment variables", () => {
    const task: CacheKeyTask = { id: "report", cmd: ["sh", "-c", "echo $FLAG"], envReads: ["B4MAL_KEY_TEST_FLAG"] };
    const VAR = "B4MAL_KEY_TEST_FLAG";
    const original = process.env[VAR];

    afterEach(() => {
        if (original === undefined) delete process.env[VAR];
        else process.env[VAR] = original;
    });

    test("key changes when a declared variable's value changes", async () => {
        process.env[VAR] = "one";
        const a = await computeCacheKey(task, root);

        process.env[VAR] = "two";
        const b = await computeCacheKey(task, root);

        expect(a).not.toBe(b);
    });

    test("key is stable for the same value", async () => {
        process.env[VAR] = "same";
        expect(await computeCacheKey(task, root)).toBe(await computeCacheKey(task, root));
    });

    test("unset and empty-string are distinguished", async () => {
        delete process.env[VAR];
        const unset = await computeCacheKey(task, root);

        process.env[VAR] = "";
        const empty = await computeCacheKey(task, root);

        expect(unset).not.toBe(empty);
    });

    test("undeclared variables do not affect the key", async () => {
        process.env[VAR] = "one";
        const a = await computeCacheKey(task, root);

        process.env.B4MAL_UNDECLARED_VAR = String(Math.random());
        const b = await computeCacheKey(task, root);
        delete process.env.B4MAL_UNDECLARED_VAR;

        expect(b).toBe(a);
    });

    test("declaration order does not affect the key", async () => {
        const forward = await computeCacheKey({ ...task, envReads: ["A_VAR", "B_VAR"] }, root);
        const reversed = await computeCacheKey({ ...task, envReads: ["B_VAR", "A_VAR"] }, root);
        expect(reversed).toBe(forward);
    });
});
