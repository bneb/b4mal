import { Worker } from "worker_threads";
import { join } from "path";

export interface WasmPluginConfig {
    url: string;
    capabilities: string[];
}

export class WasmRuntime {
    private bytes: Uint8Array | ArrayBuffer | null = null;
    
    async loadBytes(bytes: ArrayBuffer | Uint8Array): Promise<void> {
        this.bytes = bytes;
    }

    async load(wasmPath: string): Promise<void> {
        const file = Bun.file(wasmPath);
        const bytes = await file.arrayBuffer();
        await this.loadBytes(bytes);
    }

    /**
     * Executes a hook exported by the WebAssembly module inside a Worker.
     * Enforces a 5-second timeout to prevent DoS.
     */
    async executeHook(hookName: string, ...args: any[]): Promise<any> {
        if (!this.bytes) {
            throw new Error("Wasm plugin not loaded.");
        }

        return new Promise((resolve, reject) => {
            const worker = new Worker(join(__dirname, "wasm_worker.ts"));
            
            const timer = setTimeout(() => {
                worker.terminate();
                reject(new Error(`Plugin execution timed out (5s limit)`));
            }, 5000);

            worker.on("message", (msg) => {
                clearTimeout(timer);
                worker.terminate();
                if (msg.success) resolve(msg.result);
                else reject(new Error(msg.error));
            });

            worker.on("error", (err) => {
                clearTimeout(timer);
                worker.terminate();
                reject(err);
            });

            worker.postMessage({ bytes: this.bytes, hookName, args });
        });
    }
}
