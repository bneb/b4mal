/**
 * Tests: Engine Verification Strictness
 */
import { describe, test, expect, afterEach } from "bun:test";
import { B4malEngine } from "../src/core/engine";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const TEST_DIR = join(process.cwd(), "tmp_engine_test");

afterEach(() => {
    if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true });
    }
});

describe("B4malEngine: Verification Strictness", () => {
    test("allows sequential tasks to touch same files", async () => {
        if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR);

        const lockfile = [
            {
                id: "task1",
                cmd: ["echo", "1"],
                claims: ["fs:foo.txt"],
                deps: [],
                reads: [],
                writes: ["foo.txt"]
            },
            {
                id: "task2",
                cmd: ["echo", "2"],
                claims: ["fs:foo.txt"],
                deps: ["task1"],
                reads: ["foo.txt"],
                writes: ["foo.txt"]
            }
        ];

        writeFileSync(join(TEST_DIR, "b4mal.lock"), JSON.stringify(lockfile));

        const engine = new B4malEngine(TEST_DIR, { dbPath: join(TEST_DIR, "test.db") });

        // This should NOT throw or return verified: false because they are in different waves
        const result = await engine.build();

        expect(result.verified).toBe(true);
        engine.close();
    });

    test("schedules parallel colliding tasks sequentially instead of rejecting", async () => {
        if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR);

        const lockfile = [
            {
                id: "task1",
                cmd: ["echo", "1"],
                claims: ["fs:dist/"], // Directory prefix
                deps: [],
                reads: [],
                writes: ["dist/"]
            },
            {
                id: "task2",
                cmd: ["echo", "2"],
                claims: ["fs:dist/bundle.js"], // File inside dist/
                deps: [], // Parallel with task1
                reads: [],
                writes: ["dist/bundle.js"]
            }
        ];

        writeFileSync(join(TEST_DIR, "b4mal.lock"), JSON.stringify(lockfile));

        const engine = new B4malEngine(TEST_DIR, { dbPath: join(TEST_DIR, "test.db") });

        // WavePlanner now splits these into two waves due to prefix awareness
        const result = await engine.build();

        expect(result.verified).toBe(true);
        expect(result.success).toBe(true);
        engine.close();
    });
});
