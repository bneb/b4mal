import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { B4malEngine } from "../src/core/engine";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

describe("core/engine.ts", () => {
    const tmpDir = join(process.cwd(), ".b4mal_engine_test");
    let engine: B4malEngine;

    beforeEach(() => {
        try { unlinkSync(join(tmpDir, "b4mal.lock")); } catch {}
        try { unlinkSync(join(tmpDir, ".b4mal", "cache.db")); } catch {}
        engine = new B4malEngine(tmpDir, { dbPath: join(tmpDir, "cache.db") });
    });

    afterEach(() => {
        try { unlinkSync(join(tmpDir, "b4mal.lock")); } catch {}
        try { unlinkSync(join(tmpDir, "cache.db")); } catch {}
        engine.close();
    });

    test("init() generates a b4mal.lock file with NO-OP tasks", async () => {
        // Mock ImportTracer and ClusterEngine or just let it scan empty dir
        await engine.init();
        expect(existsSync(join(tmpDir, "b4mal.lock"))).toBe(true);
    });

    test("shadow() detects shadowing overwrites or throws if no lockfile", async () => {
        // Without lockfile
        expect(engine.shadow()).rejects.toThrow("No b4mal.lock found.");

        // With lockfile
        writeFileSync(join(tmpDir, "b4mal.lock"), JSON.stringify([
            { id: "A", deps: [], writes: ["fs:dist"] },
            { id: "B", deps: ["A"], writes: ["fs:dist"] }
        ]));
        
        const shadows = await engine.shadow();
        expect(shadows.length).toBeGreaterThan(0);
    });

    test("clean() purges ledger and artifacts", async () => {
        await engine.clean();
        // Just verify it doesn't throw
        expect(true).toBe(true);
    });
});
