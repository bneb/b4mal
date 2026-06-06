import { describe, test, expect } from "bun:test";
import { WasmRegistry } from "../src/plugin/wasm_registry";
import * as fs from "fs/promises";

describe("Decentralized Plugin Registry", () => {
    test("installs a mocked WASM file and rejects directory traversal", async () => {
        const registry = new WasmRegistry();

        // 1. Install mock WASM
        const outPath = await registry.install("mock://fake", "test_plugin");
        expect(outPath).toContain("test_plugin.wasm");
        const exists = await fs.access(outPath).then(()=>true).catch(()=>false);
        expect(exists).toBe(true);

        // 2. Reject directory traversal
        try {
            await registry.install("mock://fake", "../evil_plugin");
            expect(false).toBe(true);
        } catch (e: any) {
            expect(e.message).toContain("Invalid plugin name");
        }

        // Clean up
        await fs.unlink(outPath).catch(()=>{});
    });
});
