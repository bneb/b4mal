/**
 * Tests: RWX Mint Transpiler Shim (RED PHASE)
 *
 * Validates YAML → b4mal pipeline transpilation:
 * DAG fidelity, command normalization, variable injection, idempotency.
 */
import { describe, test, expect } from "bun:test";
import { MintTranspiler, type TranspileResult } from "../src/shim/mint_transpiler";
import { PipelineSchema } from "../src/schema";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SIMPLE_YAML = `
key: simple-ci
tasks:
  - key: build
    run: npm run build
  - key: test
    run: npm test
    after:
      - build
`;

const COMPLEX_YAML = `
key: fullstack-ci
values:
  node-version: "20"
  registry: ghcr.io/acme
tasks:
  - key: install
    run: npm ci --frozen-lockfile
    env:
      NODE_ENV: development
  - key: lint
    run: npm run lint
    after:
      - install
  - key: typecheck
    run: npx tsc --noEmit
    after:
      - install
  - key: test
    run: npm test -- --coverage && npm run test:integration
    after:
      - lint
      - typecheck
    env:
      CI: "true"
      NODE_VERSION: \${{ values.node-version }}
  - key: build-fe
    run: npm run build:fe
    after:
      - test
  - key: build-be
    run: npm run build:be
    after:
      - test
  - key: docker
    run: docker build -t \${{ values.registry }}/app:latest .
    after:
      - build-fe
      - build-be
    env:
      DOCKER_BUILDKIT: "1"
`;

// ─── DAG Fidelity ─────────────────────────────────────────────────────────────

describe("MintTranspiler", () => {
    test("transpiles simple 2-task pipeline with dependency", () => {
        const result = MintTranspiler.transpile(SIMPLE_YAML);

        expect(result.pipeline.name).toBe("simple-ci");
        expect(result.pipeline.tasks).toHaveLength(2);

        const build = result.pipeline.tasks.find((t) => t.id === "build")!;
        expect(build.cmd).toEqual(["npm", "run", "build"]);
        expect(build.dependencies).toEqual([]);

        const test_ = result.pipeline.tasks.find((t) => t.id === "test")!;
        expect(test_.cmd).toEqual(["npm", "test"]);
        expect(test_.dependencies).toEqual(["build"]);
    });

    test("transpiles use keyword as dependencies", () => {
        const USE_YAML = `
tasks:
  - key: a
    run: echo a
  - key: b
    run: echo b
  - key: c
    use: [a, b]
    run: cat foo.txt
`;
        const result = MintTranspiler.transpile(USE_YAML);
        const taskC = result.pipeline.tasks.find(t => t.id === "c")!;
        expect(taskC.dependencies).toEqual(["a", "b"]);
    });

    test("preserves exact DAG edges in complex pipeline", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);

        expect(result.pipeline.tasks).toHaveLength(7);

        const docker = result.pipeline.tasks.find((t) => t.id === "docker")!;
        expect(docker.dependencies).toEqual(["build-fe", "build-be"]);

        const test_ = result.pipeline.tasks.find((t) => t.id === "test")!;
        expect(test_.dependencies).toEqual(["lint", "typecheck"]);

        // lint and typecheck both depend on install
        const lint = result.pipeline.tasks.find((t) => t.id === "lint")!;
        const tc = result.pipeline.tasks.find((t) => t.id === "typecheck")!;
        expect(lint.dependencies).toEqual(["install"]);
        expect(tc.dependencies).toEqual(["install"]);
    });

    // ─── Command Normalization ────────────────────────────────────────────

    test("splits simple run command into cmd array", () => {
        const result = MintTranspiler.transpile(SIMPLE_YAML);
        const build = result.pipeline.tasks.find((t) => t.id === "build")!;
        expect(build.cmd).toEqual(["npm", "run", "build"]);
    });

    test("wraps composite commands (&&) in sh -c", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);
        const test_ = result.pipeline.tasks.find((t) => t.id === "test")!;

        // Composite commands must be wrapped in sh -c
        expect(test_.cmd[0]).toBe("sh");
        expect(test_.cmd[1]).toBe("-c");
        expect(test_.cmd[2]).toContain("&&");
    });

    test("preserves flags and arguments in cmd array", () => {
        const yaml = `
key: flags
tasks:
  - key: install
    run: npm ci --frozen-lockfile
`;
        const result = MintTranspiler.transpile(yaml);
        const install = result.pipeline.tasks[0];
        expect(install.cmd).toEqual(["npm", "ci", "--frozen-lockfile"]);
    });

    // ─── Variable Injection ───────────────────────────────────────────────

    test("flags ${{ values.* }} placeholders in warnings", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some((w) => w.includes("values.node-version"))).toBe(true);
        expect(result.warnings.some((w) => w.includes("values.registry"))).toBe(true);
    });

    test("maps ${{ values.* }} to environment variable lookups", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);
        const test_ = result.pipeline.tasks.find((t) => t.id === "test")!;
        // The placeholder should be mapped to a B4MAL_ prefixed env var
        expect(test_.env.NODE_VERSION).toContain("B4MAL_");
    });

    // ─── Environment Variables ────────────────────────────────────────────

    test("preserves static env vars exactly", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);
        const install = result.pipeline.tasks.find((t) => t.id === "install")!;
        expect(install.env.NODE_ENV).toBe("development");

        const docker = result.pipeline.tasks.find((t) => t.id === "docker")!;
        expect(docker.env.DOCKER_BUILDKIT).toBe("1");
    });

    // ─── Zod Validation ──────────────────────────────────────────────────

    test("output pipeline validates against PipelineSchema", () => {
        const result = MintTranspiler.transpile(SIMPLE_YAML);
        const parsed = PipelineSchema.safeParse(result.pipeline);
        expect(parsed.success).toBe(true);
    });

    // ─── Idempotency ─────────────────────────────────────────────────────

    test("transpiling same YAML twice produces identical output", () => {
        const result1 = MintTranspiler.transpile(COMPLEX_YAML);
        const result2 = MintTranspiler.transpile(COMPLEX_YAML);

        expect(JSON.stringify(result1.pipeline)).toBe(JSON.stringify(result2.pipeline));
        expect(result1.typescript).toBe(result2.typescript);
    });

    // ─── TypeScript Generation ────────────────────────────────────────────

    test("generates valid TypeScript source", () => {
        const result = MintTranspiler.transpile(SIMPLE_YAML);
        expect(result.typescript).toContain("import");
        expect(result.typescript).toContain("PipelineSchema");
        expect(result.typescript).toContain("simple-ci");
    });

    // ─── Isolation Forecast ─────────────────────────────────────────────

    test("generates isolation forecast", () => {
        const result = MintTranspiler.transpile(COMPLEX_YAML);
        expect(result.forecast).toBeDefined();
        expect(result.forecast.taskCount).toBe(7);
        expect(result.forecast.estimatedTaxRecovery).toBeGreaterThan(0);
        expect(result.forecast.message).toContain("b4mal");
    });
});
