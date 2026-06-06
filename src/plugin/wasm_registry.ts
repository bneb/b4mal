import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class WasmRegistry {
    private registryDir: string;

    constructor() {
        this.registryDir = path.join(os.homedir(), ".b4mal", "plugins");
        if (!fs.existsSync(this.registryDir)) {
            fs.mkdirSync(this.registryDir, { recursive: true, mode: 0o700 });
        }
    }

    public async install(url: string, name: string): Promise<string> {
        // Red Team Mitigation: prevent directory traversal
        if (name.includes("/") || name.includes("\\") || name.includes("..")) {
            throw new Error("Invalid plugin name");
        }

        let res;
        try {
            res = await fetch(url);
        } catch (e: any) {
            // Test mock fallback for file:// or pure mock
            if (url.startsWith("mock://")) {
                const dummyWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
                res = { ok: true, arrayBuffer: async () => dummyWasm.buffer };
            } else {
                throw e;
            }
        }
        
        if (!res.ok) throw new Error(`Failed to download plugin: ${res.statusText}`);
        
        const buffer = await res.arrayBuffer();
        
        // Basic WASM header validation: \0asm
        const headerView = new Uint8Array(buffer.slice(0, 4));
        if (headerView[0] !== 0x00 || headerView[1] !== 0x61 || headerView[2] !== 0x73 || headerView[3] !== 0x6d) {
            throw new Error("Invalid WebAssembly magic number");
        }

        const pluginPath = path.join(this.registryDir, `${name}.wasm`);
        fs.writeFileSync(pluginPath, Buffer.from(buffer));
        return pluginPath;
    }

    public async run(name: string): Promise<number> {
        if (name.includes("/") || name.includes("\\") || name.includes("..")) {
            throw new Error("Invalid plugin name");
        }

        const pluginPath = path.join(this.registryDir, `${name}.wasm`);
        if (!fs.existsSync(pluginPath)) {
            throw new Error(`Plugin ${name} not found. Install it first.`);
        }

        const wasmBuffer = fs.readFileSync(pluginPath);
        
        // Red Team Mitigation: Restricted execution environment.
        const importObject = {
            env: {}
        };

        const { instance } = await WebAssembly.instantiate(wasmBuffer, importObject);
        
        if (typeof (instance.exports as any).main === "function") {
            return (instance.exports as any).main();
        } else {
            throw new Error("Plugin does not export a 'main' function.");
        }
    }
}
