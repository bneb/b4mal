import { describe, test, expect } from "bun:test";
import { BuildDoctor } from "../src/agent/build_doctor";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("BuildDoctor", () => {
    test("diagnoseAndHeal creates shadow sandbox and excludes node_modules", async () => {
        const root = path.join(os.tmpdir(), `b4mal-test-doctor-${Date.now()}`);
        await fs.mkdir(root, { recursive: true });

        // Create dummy files
        await fs.writeFile(path.join(root, "package.json"), "{}");
        await fs.mkdir(path.join(root, "src"));
        await fs.writeFile(path.join(root, "src", "index.ts"), "console.log(1)");

        // Create node_modules and .b4mal which should be ignored
        await fs.mkdir(path.join(root, "node_modules"));
        await fs.writeFile(path.join(root, "node_modules", "ignore.js"), "");

        await fs.mkdir(path.join(root, ".b4mal"));
        await fs.writeFile(path.join(root, ".b4mal", "should_ignore"), "");

        const doctor = new BuildDoctor(root);
        const shadowPath = await doctor.diagnoseAndHeal("failingTask", "error", "error");

        expect(shadowPath).toBe(path.join(root, ".b4mal", "shadow", "failingTask"));

        const exists = await fs.access(shadowPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);

        const pkgExists = await fs.access(path.join(shadowPath, "package.json")).then(() => true).catch(() => false);
        expect(pkgExists).toBe(true);

        const nmExists = await fs.access(path.join(shadowPath, "node_modules")).then(() => true).catch(() => false);
        expect(nmExists).toBe(false);

        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    });

    test("diagnoseAndHeal rejects malicious taskIds to prevent path traversal", async () => {
        const root = path.join(os.tmpdir(), "b4mal-test-doctor");
        const doctor = new BuildDoctor(root);
        
        await expect(doctor.diagnoseAndHeal("../../etc/passwd", "", "")).rejects.toThrow("Invalid taskId format: ../../etc/passwd");
    });

    test("createHealPR rejects malicious taskIds to prevent command injection", async () => {
        const root = path.join(os.tmpdir(), "b4mal-test-doctor");
        const doctor = new BuildDoctor(root);
        
        await expect(doctor.createHealPR("; rm -rf /;", root)).rejects.toThrow("Invalid taskId format: ; rm -rf /;");
    });
});
