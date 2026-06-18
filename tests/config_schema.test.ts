/**
 * Tests for TaskConfigSchema and B4malConfigSchema
 *
 * These tests MUST fail before implementation (red phase).
 * They define the contract the implementation must satisfy.
 */

import { describe, test, expect } from "bun:test";
import {
  TaskConfigSchema,
  B4malConfigSchema,
  sanitizePath,
} from "../src/schema";

// ─── sanitizePath ──────────────────────────────────────────────────────────

describe("sanitizePath", () => {
  test("rejects absolute paths", () => {
    expect(() => sanitizePath("/etc/passwd")).toThrow();
    expect(() => sanitizePath("/home/user/project")).toThrow();
  });

  test("rejects path traversal (..)", () => {
    expect(() => sanitizePath("../outside")).toThrow();
    expect(() => sanitizePath("src/../../etc")).toThrow();
    expect(() => sanitizePath("foo/..")).toThrow();
  });

  test("normalizes backslashes to forward slashes", () => {
    expect(sanitizePath("src\\components\\button")).toBe("src/components/button");
  });

  test("passes valid relative paths", () => {
    expect(sanitizePath("src")).toBe("src");
    expect(sanitizePath("src/components")).toBe("src/components");
    expect(sanitizePath("packages/frontend/dist")).toBe("packages/frontend/dist");
  });

  test("passes single-dot segments", () => {
    expect(sanitizePath("./src")).toBe("./src");
  });
});

// ─── TaskConfigSchema ──────────────────────────────────────────────────────

describe("TaskConfigSchema", () => {
  // ── Valid tasks ────────────────────────────────────────────────────────

  test("accepts minimal valid task (only cmd)", () => {
    const result = TaskConfigSchema.parse({
      cmd: ["echo", "hello"],
    });
    expect(result.cmd).toEqual(["echo", "hello"]);
    expect(result.cmd).toEqual(["echo", "hello"]);
    expect(result.dependencies).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.needsEnv).toEqual([]);
    expect(result.providesEnv).toEqual([]);
    expect(result.env).toEqual({});
    expect(result.cache).toBe(true);
  });

  test("accepts full task with all fields", () => {
    const result = TaskConfigSchema.parse({
      cmd: ["bun", "run", "deploy.ts"],
      dependencies: ["build", "test"],
      inputs: ["dist", "config/deploy.json"],
      outputs: ["deploy-log.txt"],
      claims: ["env:DEPLOY_TOKEN", "port:8080"],
      needsEnv: ["HOME", "PATH"],
      providesEnv: ["DEPLOY_STATUS"],
      env: { NODE_ENV: "production" },
      cwd: "packages/server",
      timeout: 600_000,
      cache: false,
    });
    expect(result.timeout).toBe(600_000);
    expect(result.cache).toBe(false);
    expect(result.cwd).toBe("packages/server");
  });

  // ── Task ID validation (at record-key level) ──────────────────────────

  test("rejects task record key with special characters", () => {
    // Task IDs come from record keys in B4malConfigSchema
    expect(() =>
      B4malConfigSchema.parse({
        tasks: {
          "build&test": { cmd: ["echo"] },
        },
      })
    ).toThrow();
  });

  test("rejects task record key with spaces", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: { "my task": { cmd: ["echo"] } },
      })
    ).toThrow();
  });

  test("accepts alphanumeric record keys with dashes and underscores", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: { "my-task_2": { cmd: ["echo"] } },
      })
    ).not.toThrow();
  });

  // ── cmd validation ─────────────────────────────────────────────────────

  test("rejects empty cmd array", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: [] })
    ).toThrow();
  });

  test("rejects missing cmd", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build" } as any)
    ).toThrow();
  });

  // ── Path sanitization (inputs/outputs) ──────────────────────────────────

  test("sanitizes inputs: rejects absolute paths", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], inputs: ["/etc"] })
    ).toThrow();
  });

  test("sanitizes inputs: rejects traversal", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], inputs: ["../src"] })
    ).toThrow();
  });

  test("sanitizes outputs: rejects absolute paths", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], outputs: ["/dist"] })
    ).toThrow();
  });

  test("sanitizes outputs: rejects traversal", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], outputs: ["dist/../out"] })
    ).toThrow();
  });

  test("normalizes backslashes in inputs", () => {
    const result = TaskConfigSchema.parse({
      id: "build",
      cmd: ["echo"],
      inputs: ["src\\lib"],
    });
    expect(result.inputs).toContain("src/lib");
  });

  // ── cwd validation ─────────────────────────────────────────────────────

  test("rejects absolute cwd", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], cwd: "/home/user" })
    ).toThrow();
  });

  test("rejects traversal in cwd", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], cwd: "../escape" })
    ).toThrow();
  });

  test("accepts relative cwd", () => {
    const result = TaskConfigSchema.parse({
      id: "build",
      cmd: ["echo"],
      cwd: "packages/frontend",
    });
    expect(result.cwd).toBe("packages/frontend");
  });

  // ── timeout validation ─────────────────────────────────────────────────

  test("rejects negative timeout", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], timeout: -1 })
    ).toThrow();
  });

  test("rejects timeout exceeding maximum (1 hour)", () => {
    expect(() =>
      TaskConfigSchema.parse({ id: "build", cmd: ["echo"], timeout: 3_600_001 })
    ).toThrow();
  });

  test("defaults timeout to 300000ms (5 minutes)", () => {
    const result = TaskConfigSchema.parse({ id: "build", cmd: ["echo"] });
    expect(result.timeout).toBe(300_000);
  });

  // ── cache validation ───────────────────────────────────────────────────

  test("defaults cache to true", () => {
    const result = TaskConfigSchema.parse({ id: "build", cmd: ["echo"] });
    expect(result.cache).toBe(true);
  });

  test("accepts cache: false", () => {
    const result = TaskConfigSchema.parse({
      id: "build",
      cmd: ["echo"],
      cache: false,
    });
    expect(result.cache).toBe(false);
  });

  // ── defaults for optional fields ───────────────────────────────────────

  test("defaults empty arrays for collection fields", () => {
    const result = TaskConfigSchema.parse({ id: "x", cmd: ["x"] });
    expect(result.dependencies).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(result.outputs).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.needsEnv).toEqual([]);
    expect(result.providesEnv).toEqual([]);
  });

  test("defaults empty object for env", () => {
    const result = TaskConfigSchema.parse({ id: "x", cmd: ["x"] });
    expect(result.env).toEqual({});
  });
});

// ─── B4malConfigSchema ────────────────────────────────────────────────────

describe("B4malConfigSchema", () => {
  // ── Valid configs ──────────────────────────────────────────────────────

  test("accepts minimal config with one task", () => {
    const result = B4malConfigSchema.parse({
      tasks: {
        build: { cmd: ["echo", "hello"] },
      },
    });
    expect(Object.keys(result.tasks)).toHaveLength(1);
  });

  test("accepts config with multiple tasks and dependencies", () => {
    const result = B4malConfigSchema.parse({
      name: "my-project",
      tasks: {
        typecheck: { cmd: ["tsc", "--noEmit"], inputs: ["src"] },
        test: {
          cmd: ["bun", "test"],
          inputs: ["src", "tests"],
          dependencies: ["typecheck"],
        },
        build: {
          cmd: ["bun", "build"],
          inputs: ["src"],
          outputs: ["dist"],
          dependencies: ["typecheck", "test"],
        },
      },
      concurrency: 4,
      env: { CI: "true" },
    });
    expect(result.name).toBe("my-project");
    expect(result.concurrency).toBe(4);
    expect(result.env).toEqual({ CI: "true" });
    expect(result.tasks.test.dependencies).toEqual(["typecheck"]);
  });

  // ── Empty config rejection ─────────────────────────────────────────────

  test("rejects empty tasks record", () => {
    expect(() => B4malConfigSchema.parse({ tasks: {} })).toThrow();
  });

  test("rejects missing tasks", () => {
    expect(() => B4malConfigSchema.parse({} as any)).toThrow();
  });

  // ── Dependency validation ──────────────────────────────────────────────

  test("rejects dependency referencing non-existent task", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: {
          build: { cmd: ["echo"], dependencies: ["missing"] },
        },
      })
    ).toThrow();
  });

  test("rejects dependency with self-reference", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: {
          build: { cmd: ["echo"], dependencies: ["build"] },
        },
      })
    ).toThrow();
  });

  test("accepts valid dependency chain", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: {
          a: { cmd: ["a"] },
          b: { cmd: ["b"], dependencies: ["a"] },
          c: { cmd: ["c"], dependencies: ["a", "b"] },
        },
      })
    ).not.toThrow();
  });

  // ── concurrency validation ─────────────────────────────────────────────

  test("defaults concurrency to 0 (unbounded)", () => {
    const result = B4malConfigSchema.parse({
      tasks: { build: { cmd: ["echo"] } },
    });
    expect(result.concurrency).toBe(0);
  });

  test("rejects negative concurrency", () => {
    expect(() =>
      B4malConfigSchema.parse({
        tasks: { build: { cmd: ["echo"] } },
        concurrency: -1,
      })
    ).toThrow();
  });

  // ── name field ─────────────────────────────────────────────────────────

  test("name is optional", () => {
    const result = B4malConfigSchema.parse({
      tasks: { build: { cmd: ["echo"] } },
    });
    expect(result.name).toBeUndefined();
  });
});
