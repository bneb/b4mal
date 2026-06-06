import { test, expect } from "bun:test";
import { TurboIngester } from "../src/discovery/turbo_ingester";
import type { Pipeline } from "../src/schema";
import * as path from "path";

test("Turborepo Ingestion - parses simple turbo.json and package.json workspaces into Pipeline", async () => {
    // 1. Mock inputs
    const turboJson = {
        pipeline: {
            "build": {
                "dependsOn": ["^build"]
            },
            "test": {
                "dependsOn": ["build"]
            }
        }
    };

    const rootPackageJson = {
        workspaces: ["packages/*"]
    };

    // We simulate finding two packages in the workspace
    const packages = [
        { name: "core", path: "packages/core", scripts: { build: "tsc", test: "bun test" } },
        { name: "web", path: "packages/web", scripts: { build: "vite build", test: "bun test" }, dependencies: { "core": "*" } }
    ];

    // 2. Instantiate and run the ingester
    const ingester = new TurboIngester();
    const pipeline: Pipeline = ingester.ingestMocked(turboJson, rootPackageJson, packages);

    // 3. Assertions
    expect(pipeline.name).toBe("Auto-generated from Turborepo");
    expect(pipeline.tasks.length).toBe(4); // web:build, core:build, web:test, core:test

    const webBuild = pipeline.tasks.find(t => t.id === "web:build");
    const coreBuild = pipeline.tasks.find(t => t.id === "core:build");
    const webTest = pipeline.tasks.find(t => t.id === "web:test");
    const coreTest = pipeline.tasks.find(t => t.id === "core:test");

    expect(webBuild).toBeDefined();
    expect(coreBuild).toBeDefined();
    expect(webTest).toBeDefined();
    expect(coreTest).toBeDefined();

    // ^build means it depends on dependencies' build scripts
    expect(webBuild?.dependencies).toContain("core:build");
    
    // test depends on build (same package)
    expect(webTest?.dependencies).toContain("web:build");
    expect(coreTest?.dependencies).toContain("core:build");
});

test("Turborepo Ingestion - ingest from filesystem", () => {
    const ingester = new TurboIngester();
    const fixturePath = path.join(__dirname, "fixtures", "turbo_workspace");
    const pipeline = ingester.ingest(fixturePath);

    expect(pipeline.name).toBe("Auto-generated from Turborepo");
    expect(pipeline.tasks.length).toBe(4);

    const webBuild = pipeline.tasks.find(t => t.id === "web:build");
    const coreBuild = pipeline.tasks.find(t => t.id === "core:build");
    const webTest = pipeline.tasks.find(t => t.id === "web:test");

    expect(webBuild?.dependencies).toContain("core:build");
    expect(webTest?.dependencies).toContain("web:build");
});

test("Turborepo Ingestion - ingest pnpm workspaces", () => {
    const ingester = new TurboIngester();
    const fixturePath = path.join(__dirname, "fixtures", "pnpm_workspace");
    const pipeline = ingester.ingest(fixturePath);

    expect(pipeline.tasks.length).toBe(1);
    expect(pipeline.tasks[0].id).toBe("app1:build");
});
