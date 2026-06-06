import { parentPort } from "worker_threads";

parentPort?.on("message", async (msg) => {
    try {
        const { bytes, hookName, args } = msg;
        
        const importObject = {
            env: {
                b4mal_log: () => { /* no-op */ }
            }
        };

        const result = await WebAssembly.instantiate(bytes, importObject);
        const hook = result.instance.exports[hookName] as Function;
        
        if (typeof hook !== "function") {
            throw new Error(`Plugin does not export hook: ${hookName}`);
        }

        const res = hook(...(args || []));
        parentPort?.postMessage({ success: true, result: res });
    } catch (e: any) {
        parentPort?.postMessage({ success: false, error: e.message });
    }
});
