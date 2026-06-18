/**
 * End-to-end smoke test: full init → build → cache verify → clean → rebuild.
 *
 * Exercises the complete pipeline to catch integration bugs that unit tests miss.
 * Uses a temporary project directory with real source files.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { B4malEngine } from "../src/core/engine";
import { loadConfig, configToTasks, writeLockfileAtomic } from "../src/config_loader";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "b4mal-smoke-"));
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// Minimal TypeScript file for a real build
const SRC_CONTENT = 'console.log("hello from b4mal smoke test");';

describe("B4mal smoke test", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    // Create minimal project structure
    writeJson(join(projectDir, "package.json"), { name: "smoke-test", scripts: { build: "echo ok" } });
    mkdirRecursive(join(projectDir, "src"));
    writeFileSync(join(projectDir, "src/index.ts"), SRC_CONTENT);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("init from config → build → cache hit → clean → cache miss", async () => {
    // Step 1: Write b4mal.config.json
    const config = {
      tasks: {
        hello: { cmd: ["echo", "smoke-test-passed"], inputs: ["src"] },
      },
    };
    writeJson(join(projectDir, "b4mal.config.json"), config);

    // Step 2: Load config and generate lockfile
    const loaded = loadConfig(projectDir);
    expect(Object.keys(loaded.tasks)).toHaveLength(1);

    const tasks = configToTasks(loaded);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("hello");

    const lockPath = join(projectDir, "b4mal.lock");
    writeLockfileAtomic(tasks, lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // Verify envelope format
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.version).toBe(2);
    expect(lockContent.tasks).toBeArray();
    expect(lockContent.tasks[0].id).toBe("hello");

    // Step 3: Build (cold — no cache)
    const engine = new B4malEngine(projectDir);
    const result1 = await engine.build();
    expect(result1.success).toBe(true);
    expect(result1.verified).toBe(true);
    expect(result1.conflicts).toHaveLength(0);
    const coldResults = result1.results.filter(r => !r.cached);
    expect(coldResults.length).toBe(1);
    expect(coldResults[0].exitCode).toBe(0);

    // Step 4: Build again (warm — L1 cache hit)
    const engine2 = new B4malEngine(projectDir);
    const result2 = await engine2.build();
    expect(result2.success).toBe(true);
    const cachedResults = result2.results.filter(r => r.cached);
    expect(cachedResults.length).toBe(1);

    // Step 5: Clean the cache
    await engine.clean();

    // Step 6: Build after clean (cold again — cache miss)
    const engine3 = new B4malEngine(projectDir);
    const result3 = await engine3.build();
    expect(result3.success).toBe(true);
    const postCleanCold = result3.results.filter(r => !r.cached);
    expect(postCleanCold.length).toBe(1);
  });
});

// Helper not available in the test scope — simple recursive mkdir
function mkdirRecursive(dir: string): void {
  const { mkdirSync, existsSync } = require("fs");
  const { dirname } = require("path");
  if (!existsSync(dir)) {
    mkdirRecursive(dirname(dir));
    mkdirSync(dir);
  }
}
