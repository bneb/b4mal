import { describe, test, expect } from "bun:test";
import { WasmRuntime } from "../src/plugins/wasm_runtime";

describe("Wasm Runtime Ecosystem", () => {
    test("loads and executes a WebAssembly plugin hook", async () => {
        const runtime = new WasmRuntime();
        
        // Minimal WebAssembly module exporting an 'add' function
        const wasmBinary = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
            0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
            0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
            0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a,
            0x0b
        ]);

        await runtime.loadBytes(wasmBinary);
        
        const result = await runtime.executeHook("add", 5, 7);
        expect(result).toBe(12);
    });

    test("executeHook throws if plugin is not loaded", async () => {
        const runtime = new WasmRuntime();
        await expect(runtime.executeHook("test")).rejects.toThrow("Wasm plugin not loaded.");
    });

    test("executeHook throws if hook does not exist", async () => {
        const runtime = new WasmRuntime();
        const wasmBinary = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
        ]); // Valid but empty module
        await runtime.loadBytes(wasmBinary);
        
        await expect(runtime.executeHook("missing")).rejects.toThrow("Plugin does not export hook: missing");
    });

    test("executeHook aborts infinite loops", async () => {
        const runtime = new WasmRuntime();
        // Wat: (module (func (export "inf") (loop (br 0))))
        const infBinary = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
            0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x69, 0x6e,
            0x66, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00,
            0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b
        ]);
        await runtime.loadBytes(infBinary);
        
        const start = performance.now();
        await expect(runtime.executeHook("inf")).rejects.toThrow("timed out");
        const elapsed = performance.now() - start;
        // Should take ~5s
        expect(elapsed).toBeGreaterThan(4900);
    }, 10000);
});
