import { describe, test, expect } from "bun:test";
import { MigrationWizard } from "../src/cli/wizard";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("MigrationWizard", () => {
    test("prompt returns null when no configs are present", async () => {
        const tmp = path.join(os.tmpdir(), `wizard-${Date.now()}`);
        await fs.mkdir(tmp);
        
        const result = await MigrationWizard.prompt(tmp);
        expect(result).toBeNull();
        
        await fs.rm(tmp, { recursive: true, force: true });
    });
});
