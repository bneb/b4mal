/**
 * Tests: the config ⇄ lockfile round trip is lossless.
 *
 * `b4mal init` now writes b4mal.config.json and derives b4mal.lock from it. That
 * only works because a task survives the trip unchanged — and this codebase has
 * shipped three fields that did not: `secrets`, `needsEnv` and `when` were each
 * written into the lockfile and then dropped on the way back out. A fourth silent
 * drop here would be invisible until a user edited a config and the change did
 * nothing.
 *
 * So the round trip is pinned as an explicit equality, per field, over a task that
 * populates the entire contract. If a future field is added to the config schema
 * and not carried through, this fails.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  tasksToConfig,
  tasksToConfigWithReport,
  configToTasks,
  writeLockfileAtomic,
  loadConfig,
} from "../src/config_loader";
import { B4malEngine } from "../src/core/engine";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b4mal-rt-"));
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The full field contract, in config field names. */
const CONTRACT_FIELDS = [
  "cmd", "dependencies", "inputs", "outputs", "claims",
  "needsEnv", "providesEnv", "secrets", "env", "cwd", "timeout", "cache", "when",
] as const;

const richConfig = {
  tasks: {
    other: { cmd: ["echo", "other"] },
    rich: {
      cmd: ["echo", "hi"],
      dependencies: ["other"],
      inputs: ["src/**"],
      outputs: ["dist/**"],
      claims: ["db:primary", "port:8080"],       // non-fs claims survive verbatim
      needsEnv: ["TOKEN"],
      providesEnv: ["MODE"],
      secrets: ["API_KEY"],
      env: { FOO: "bar" },
      cwd: "sub/dir",
      timeout: 12345,
      cache: false,
      when: { platform: ["linux"], branch: "main" },
    },
  },
};

describe("config → lock → config round trip", () => {
  test("every contract field survives load → configToTasks → lock → read-back", () => {
    const configPath = join(dir, "b4mal.config.json");
    writeFileSync(configPath, JSON.stringify(richConfig, null, 2), "utf-8");

    // config file → (Zod-validated) tasks
    const loaded = loadConfig(dir);
    const fromConfig = configToTasks(loaded);
    const richFromConfig = fromConfig.find(t => t.id === "rich")!;
    expect(richFromConfig).toBeDefined();

    // tasks → lockfile
    writeLockfileAtomic(fromConfig, join(dir, "b4mal.lock"));

    // lockfile → tasks (the engine's real normalizer)
    const engine = new B4malEngine(dir);
    const raw = JSON.parse(readFileSync(join(dir, "b4mal.lock"), "utf-8"));
    const normalized = (engine as any).normalizeLockTasks(raw);
    engine.close();
    const richFromLock = normalized.find((t: any) => t.id === "rich");

    // The whole point: nothing dropped on the way through the lockfile.
    for (const field of CONTRACT_FIELDS) {
      const before = (richFromConfig as any)[field];
      const after = (richFromLock as any)?.[field];
      if (field === "cwd") {
        // cwd is optional and normalized with forward slashes.
        expect(after).toBe(before ? String(before).replace(/\\/g, "/") : after);
        continue;
      }
      expect(JSON.stringify(after), `field "${field}" was lost on the round trip`).toEqual(
        JSON.stringify(before),
      );
    }
  });

  test("secrets, needsEnv and when — the three that have each broken before — survive", () => {
    // Named explicitly so a regression names itself.
    const configPath = join(dir, "b4mal.config.json");
    writeFileSync(configPath, JSON.stringify(richConfig, null, 2), "utf-8");
    const fromConfig = configToTasks(loadConfig(dir));
    writeLockfileAtomic(fromConfig, join(dir, "b4mal.lock"));

    const engine = new B4malEngine(dir);
    const normalized = (engine as any).normalizeLockTasks(
      JSON.parse(readFileSync(join(dir, "b4mal.lock"), "utf-8")),
    );
    engine.close();
    const rich = normalized.find((t: any) => t.id === "rich");

    expect(rich.secrets).toEqual(["API_KEY"]);
    expect(rich.needsEnv).toEqual(["TOKEN"]);
    expect(rich.providesEnv).toEqual(["MODE"]);
    expect(rich.when).toEqual({ platform: ["linux"], branch: "main" });
  });
});

describe("tasksToConfig (init's converter)", () => {
  test("emits a config that parses and reproduces the same tasks", () => {
    const discovered = [
      {
        id: "build",
        cmd: ["npm", "run", "build"],
        deps: [],
        reads: [],
        writes: ["dist"],
        // init puts fs paths in claims too; the converter must not double them up
        claims: ["fs:dist"],
        envReads: [],
        envWrites: [],
      },
    ];

    const config = tasksToConfig(discovered);
    // fs claim dropped: the path is already expressed via outputs.
    expect(config.tasks.build.claims).toBeUndefined();
    expect(config.tasks.build.outputs).toEqual(["dist"]);

    // Write it out and read it back through the real, validated path.
    writeFileSync(join(dir, "b4mal.config.json"), JSON.stringify(config, null, 2), "utf-8");
    const reloaded = configToTasks(loadConfig(dir));

    expect(reloaded.length).toBe(1);
    expect(reloaded[0].id).toBe("build");
    expect(reloaded[0].cmd).toEqual(["npm", "run", "build"]);
    expect(reloaded[0].outputs).toEqual(["dist"]);
  });

  test("keeps non-filesystem claims", () => {
    const config = tasksToConfig([
      { id: "t", cmd: ["echo"], deps: [], reads: [], writes: [], claims: ["env:PORT", "fs:x", "db:main"], envReads: [], envWrites: [] },
    ]);
    expect(config.tasks.t.claims).toEqual(["env:PORT", "db:main"]);
  });

  test("carries the fields init would otherwise lose", () => {
    // `other` is included as a real task: an edge to a task that does not exist
    // is pruned (the config schema forbids dangling references), so it has to be
    // present for `dependencies` to survive.
    const config = tasksToConfig([
      { id: "other", cmd: ["echo"], deps: [], reads: [], writes: [], claims: [], envReads: [], envWrites: [] },
      {
        id: "t", cmd: ["echo"], deps: ["other"], reads: ["in"], writes: ["out"],
        claims: [], envReads: ["A"], envWrites: ["B"], secrets: ["S"],
        env: { K: "v" }, cwd: "sub", timeout: 999, cache: false,
        when: { platform: ["linux"] },
      },
    ]);
    expect(config.tasks.t).toMatchObject({
      dependencies: ["other"], inputs: ["in"], outputs: ["out"],
      needsEnv: ["A"], providesEnv: ["B"], secrets: ["S"],
      env: { K: "v" }, cwd: "sub", timeout: 999, cache: false,
      when: { platform: ["linux"] },
    });
  });

  test("prunes edges that the config schema forbids, and says which", () => {
    const { config, prunedEdges } = tasksToConfigWithReport([
      { id: "a", cmd: ["echo"], deps: ["b"], reads: [], writes: [], claims: [], envReads: [], envWrites: [] },
      { id: "b", cmd: ["echo"], deps: ["a"], reads: [], writes: [], claims: [], envReads: [], envWrites: [] },
      { id: "c", cmd: ["echo"], deps: ["ghost"], reads: [], writes: [], claims: [], envReads: [], envWrites: [] },
    ]);

    // The a↔b cycle is broken and the dangling edge to `ghost` is removed, so the
    // config is loadable.
    expect(config.tasks.a.dependencies ?? []).toEqual(["b"]);
    expect(config.tasks.b.dependencies).toBeUndefined();
    expect(config.tasks.c.dependencies).toBeUndefined();

    // ...and nothing was removed silently.
    expect(prunedEdges.some(e => e.includes("ghost"))).toBe(true);
    expect(prunedEdges.some(e => e.includes("cycle"))).toBe(true);
  });

  test("omits defaults so the emitted config stays readable", () => {
    const config = tasksToConfig([
      { id: "t", cmd: ["echo"], deps: [], reads: [], writes: [], claims: [], envReads: [], envWrites: [], timeout: 300000, cache: true },
    ]);
    // Nothing non-default, so only cmd.
    expect(Object.keys(config.tasks.t)).toEqual(["cmd"]);
  });
});