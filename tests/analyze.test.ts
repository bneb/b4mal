import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { B4malEngine } from "../src/core/engine";
import { join } from "path";
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "fs";

describe("Visual Observability Dashboard", () => {
    const projectRoot = join(__dirname, ".test_analyze");
    const lockPath = join(projectRoot, "b4mal.lock");
    const reportPath = join(projectRoot, "b4mal-report.html");

    beforeAll(() => {
        mkdirSync(projectRoot, { recursive: true });
        const mockTasks = [
            { id: "task-A", cmd: ["echo"], deps: [], claims: [] },
            { id: "task-B", cmd: ["echo"], deps: ["task-A"], claims: [] },
        ];
        writeFileSync(lockPath, JSON.stringify(mockTasks));
    });

    afterAll(() => {
        rmSync(projectRoot, { recursive: true, force: true });
    });

    test("engine.analyze generates self-contained HTML report", async () => {
        const engine = new B4malEngine(projectRoot);
        const outPath = await engine.analyze();
        
        expect(outPath).toBe(reportPath);
        expect(existsSync(reportPath)).toBe(true);

        const html = readFileSync(reportPath, "utf-8");
        expect(html).toContain("B4mal Observability Dashboard");
        expect(html).toContain("const b4malData = {");
        expect(html).toContain('"taskIds":["task-A"]');
        expect(html).toContain('"taskIds":["task-B"]');
    });

    test("XSS payload in task ID is escaped properly", async () => {
        const xssTasks = [
            { id: "</script><script>alert(1)</script>", cmd: ["echo"], deps: [], claims: [] },
        ];
        writeFileSync(lockPath, JSON.stringify(xssTasks));
        const engine = new B4malEngine(projectRoot);
        await engine.analyze();
        
        const html = readFileSync(reportPath, "utf-8");
        expect(html).not.toContain("</script><script>alert(1)</script>");
        expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
    });
});
