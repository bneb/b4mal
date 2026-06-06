/**
 * Tests: Schema validation
 */
import { describe, test, expect } from "bun:test";
import { TaskSchema, PipelineSchema } from "../src/schema";

describe("TaskSchema", () => {
    test("valid task parses correctly", () => {
        const result = TaskSchema.safeParse({
            id: "build",
            cmd: ["npm", "run", "build"],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.id).toBe("build");
            expect(result.data.dependencies).toEqual([]);
            expect(result.data.env).toEqual({});
            expect(result.data.timeout).toBe(0);
        }
    });

    test("rejects task with empty id", () => {
        const result = TaskSchema.safeParse({ id: "", cmd: ["echo"] });
        expect(result.success).toBe(false);
    });

    test("rejects task with no cmd", () => {
        const result = TaskSchema.safeParse({ id: "test" });
        expect(result.success).toBe(false);
    });

    test("rejects task with empty cmd array", () => {
        const result = TaskSchema.safeParse({ id: "test", cmd: [] });
        expect(result.success).toBe(false);
    });

    test("fills defaults for optional fields", () => {
        const result = TaskSchema.parse({ id: "t", cmd: ["echo", "hi"] });
        expect(result.env).toEqual({});
        expect(result.dependencies).toEqual([]);
        expect(result.cwd).toBeUndefined();
        expect(result.timeout).toBe(0);
    });

    test("accepts full task with all fields", () => {
        const result = TaskSchema.parse({
            id: "deploy",
            cmd: ["bash", "-c", "deploy.sh"],
            env: { NODE_ENV: "production" },
            dependencies: ["build", "test"],
            cwd: "/app",
            timeout: 30000,
        });
        expect(result.dependencies).toEqual(["build", "test"]);
        expect(result.env.NODE_ENV).toBe("production");
        expect(result.timeout).toBe(30000);
    });
});

describe("PipelineSchema", () => {
    test("valid pipeline parses correctly", () => {
        const result = PipelineSchema.safeParse({
            name: "ci",
            tasks: [{ id: "lint", cmd: ["eslint", "."] }],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.concurrency).toBe(0);
            expect(result.data.env).toEqual({});
        }
    });

    test("rejects pipeline with no tasks", () => {
        const result = PipelineSchema.safeParse({ name: "empty", tasks: [] });
        expect(result.success).toBe(false);
    });

    test("rejects pipeline with no name", () => {
        const result = PipelineSchema.safeParse({
            tasks: [{ id: "a", cmd: ["echo"] }],
        });
        expect(result.success).toBe(false);
    });
});
