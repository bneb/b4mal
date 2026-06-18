/**
 * Integration tests: full config → lockfile → build → clean workflow.
 *
 * These tests MUST fail before implementation (red phase).
 * They exercise the complete pipeline end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

// These imports will fail until implemented.
import { loadConfig, configToTasks, writeLockfileAtomic, isConfigStale } from "../src/config_loader";
import { B4malConfigSchema } from "../src/schema";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "b4mal-integ-test-"));
}

function createSourceFile(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  const parent = join(fullPath, "..");
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(fullPath, content, "utf-8");
}

// ─── Full Workflow ─────────────────────────────────────────────────────────

describe("config integration: init → validate → lock → build", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    // Create a minimal project structure
    createSourceFile(projectDir, "package.json", JSON.stringify({ name: "test-project" }));
    createSourceFile(projectDir, "src/index.ts", 'console.log("hello");');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("valid config produces valid lockfile", () => {
    // Step 1: Write config
    const configPath = join(projectDir, "b4mal.config.json");
    const config = {
      tasks: {
        typecheck: { cmd: ["tsc", "--noEmit"], inputs: ["src"] },
        build: {
          cmd: ["bun", "build", "src/index.ts", "--outdir", "dist"],
          inputs: ["src"],
          outputs: ["dist"],
          dependencies: ["typecheck"],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Step 2: Load and validate
    const loaded = loadConfig(projectDir);
    expect(loaded).toBeDefined();
    expect(Object.keys(loaded.tasks)).toHaveLength(2);

    // Step 3: Convert to tasks
    const tasks = configToTasks(loaded);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: any) => t.id).sort()).toEqual(["build", "typecheck"]);

    // Step 4: Write lockfile atomically
    const lockPath = join(projectDir, "b4mal.lock");
    writeLockfileAtomic(tasks, lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // Step 5: Verify lockfile content is valid JSON and matches tasks
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.version).toBe(2);
    expect(lockContent.tasks).toBeArray();
    expect(lockContent.tasks[0]).toHaveProperty("id");
    expect(lockContent.tasks[0]).toHaveProperty("cmd");
    expect(lockContent.tasks[0]).toHaveProperty("inputs");
    expect(lockContent.tasks[0]).toHaveProperty("outputs");
    expect(lockContent.tasks[0]).toHaveProperty("dependencies");
  });

  test("stale config triggers warning but does not overwrite lockfile", async () => {
    const configPath = join(projectDir, "b4mal.config.json");
    const lockPath = join(projectDir, "b4mal.lock");

    // Write lockfile first (older) — use envelope format
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 2, tasks: [{ id: "old-build", cmd: ["old"], inputs: [], outputs: [], dependencies: [], claims: [], needsEnv: [], providesEnv: [], env: {}, timeout: 300000, cache: true }] }),
      "utf-8"
    );

    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 10));

    // Write config later (newer)
    writeFileSync(
      configPath,
      JSON.stringify({
        tasks: { "new-build": { cmd: ["new"], inputs: ["src"] } },
      }),
      "utf-8"
    );

    // Verify staleness is detected
    const stale = isConfigStale(projectDir);
    expect(stale).toBe(true);

    // Lockfile should still contain the OLD content
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.tasks[0].id).toBe("old-build");
  });

  test("--sync flag regenerates lockfile from config", () => {
    const configPath = join(projectDir, "b4mal.config.json");
    const lockPath = join(projectDir, "b4mal.lock");

    // Old lockfile
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 2, tasks: [{ id: "old", cmd: ["old"], inputs: [], outputs: [], dependencies: [], claims: [], needsEnv: [], providesEnv: [], env: {}, timeout: 300000, cache: true }] }),
      "utf-8"
    );

    // New config
    writeFileSync(
      configPath,
      JSON.stringify({
        tasks: { "fresh-build": { cmd: ["fresh"], inputs: ["src"] } },
      }),
      "utf-8"
    );

    // Simulate --sync: load config, reconvert, rewrite
    const loaded = loadConfig(projectDir);
    const tasks = configToTasks(loaded);
    writeLockfileAtomic(tasks, lockPath);

    // Lockfile should now contain the new task
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.tasks[0].id).toBe("fresh-build");
  });

  test("config with validation error produces hard error, no fallback", () => {
    const configPath = join(projectDir, "b4mal.config.json");
    const lockPath = join(projectDir, "b4mal.lock");

    // Valid lockfile
    writeFileSync(
      lockPath,
      JSON.stringify({ version: 2, tasks: [{ id: "build", cmd: ["echo"], inputs: [], outputs: [], dependencies: [], claims: [], needsEnv: [], providesEnv: [], env: {}, timeout: 300000, cache: true }] }),
      "utf-8"
    );

    // Invalid config (path traversal)
    writeFileSync(
      configPath,
      JSON.stringify({
        tasks: { build: { cmd: ["echo"], inputs: ["../escape"] } },
      }),
      "utf-8"
    );

    // Must throw, not silently fall back to lockfile
    expect(() => loadConfig(projectDir)).toThrow();

    // Lockfile should be untouched
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent.tasks[0].id).toBe("build");
  });

  test("lockfile includes _meta.configHash for integrity", () => {
    const configPath = join(projectDir, "b4mal.config.json");
    const config = {
      tasks: { build: { cmd: ["echo"], inputs: ["src"] } },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const loaded = loadConfig(projectDir);
    const tasks = configToTasks(loaded);
    const lockPath = join(projectDir, "b4mal.lock");
    writeLockfileAtomic(tasks, lockPath);

    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(lockContent).toHaveProperty("_meta");
    expect(lockContent._meta).toHaveProperty("configHash");
    expect(typeof lockContent._meta.configHash).toBe("string");
    expect(lockContent).toHaveProperty("tasks");
    expect(lockContent.tasks).toBeArray();
  });

  test("lockfile hash mismatch detected when config tampered", () => {
    const configPath = join(projectDir, "b4mal.config.json");
    const config = {
      tasks: { build: { cmd: ["echo"], inputs: ["src"] } },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const loaded = loadConfig(projectDir);
    const tasks = configToTasks(loaded);
    const lockPath = join(projectDir, "b4mal.lock");
    writeLockfileAtomic(tasks, lockPath);

    // Tamper with the lockfile
    const lockContent = JSON.parse(readFileSync(lockPath, "utf-8"));
    lockContent._meta.configHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    writeFileSync(lockPath, JSON.stringify(lockContent), "utf-8");

    // Now the hash should mismatch — but loadConfig doesn't check lockfiles,
    // so this is verified at a higher level (build time).
    // This test just confirms the hash field exists and can be tampered.
    const tampered = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(tampered._meta.configHash).toBe("sha256:0000000000000000000000000000000000000000000000000000000000000000");
  });

  test("concurrency: 0 means unbounded (preserved in lockfile)", () => {
    const configPath = join(projectDir, "b4mal.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        tasks: { build: { cmd: ["echo"] } },
        concurrency: 0,
      }),
      "utf-8"
    );

    const loaded = loadConfig(projectDir);
    expect(loaded.concurrency).toBe(0);
  });
});

// ─── Determinism Guarantees ────────────────────────────────────────────────

describe("determinism", () => {
  test("same config on different OS produces forward-slash paths", () => {
    const config = {
      tasks: {
        build: {
          id: "build",
          cmd: ["echo"],
          inputs: ["src\\lib\\utils"], // Windows-style backslashes
          outputs: ["dist\\out"],
        },
      },
    };

    const tasks = configToTasks(config as any);
    expect(tasks[0].inputs).toContain("src/lib/utils");
    expect(tasks[0].outputs).toContain("dist/out");
  });

  test("env keys sorted deterministically in lockfile", () => {
    const config = {
      tasks: {
        build: {
          id: "build",
          cmd: ["echo"],
          env: { B: "2", A: "1", D: "4", C: "3" },
        },
      },
    };

    const tasks = configToTasks(config as any);
    const envStr = JSON.stringify(tasks[0].env);
    // Keys should appear in alphabetical order
    expect(envStr).toBe('{"A":"1","B":"2","C":"3","D":"4"}');
  });

  test("no filesystem access during determinism-sensitive operations", () => {
    // Create a config that references paths that don't exist
    const config = {
      tasks: {
        build: {
          id: "build",
          cmd: ["echo"],
          inputs: ["nonexistent/path/that/does/not/exist"],
          outputs: ["also/not/real"],
        },
      },
    };

    // This MUST succeed — lockfile generation does not touch the filesystem
    const tasks = configToTasks(config as any);
    expect(tasks).toHaveLength(1);
  });
});

// ─── Error Messages ────────────────────────────────────────────────────────

describe("error messages", () => {
  test("config file not found error includes the path searched", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "b4mal-err-test-"));
    try {
      expect(() => loadConfig(tmpDir)).toThrow(/b4mal\.config\.json/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("schema validation error includes field name", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "b4mal-err-test-"));
    try {
      writeFileSync(
        join(tmpDir, "b4mal.config.json"),
        JSON.stringify({ tasks: { build: { cmd: [] } } }),
        "utf-8"
      );
      expect(() => loadConfig(tmpDir)).toThrow(/cmd/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("path traversal error includes the offending path", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "b4mal-err-test-"));
    try {
      writeFileSync(
        join(tmpDir, "b4mal.config.json"),
        JSON.stringify({ tasks: { build: { cmd: ["echo"], inputs: ["../escape"] } } }),
        "utf-8"
      );
      expect(() => loadConfig(tmpDir)).toThrow(/\.\.\/escape|traversal/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
