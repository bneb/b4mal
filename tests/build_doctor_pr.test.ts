import { describe, test, expect } from "bun:test";
import { BuildDoctor } from "../src/agent/build_doctor";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("BuildDoctor PR Generation", () => {
    test("createHealPR simulates a fix and returns the PR URL", async () => {
        const root = path.join(os.tmpdir(), `b4mal-test-doctor-pr-${Date.now()}`);
        await fs.mkdir(root, { recursive: true });

        const shadowDir = path.join(root, "shadow-fake");
        await fs.mkdir(shadowDir, { recursive: true });
        
        await fs.writeFile(path.join(shadowDir, "package.json"), "{}");

        const doctor = new BuildDoctor(root);
        const prUrl = await doctor.createHealPR("failingTask", shadowDir);

        expect(prUrl).toContain("b4mal-heal-failingTask");

        // Verify the simulated fix occurred
        const pkg = JSON.parse(await fs.readFile(path.join(shadowDir, "package.json"), "utf8"));
        expect(pkg.b4malHealed).toBeDefined();

        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    });
});
