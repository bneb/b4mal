import { join } from "path";
import { writeFileSync } from "fs";

export async function installPlugin(url: string, destDir: string): Promise<string> {
    console.log(`[b4mal plugin] Downloading ${url}...`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to download plugin: ${res.statusText}`);
    }
    const bytes = await res.arrayBuffer();
    const filename = url.substring(url.lastIndexOf("/") + 1) || "plugin.wasm";
    const dest = join(destDir, filename);
    writeFileSync(dest, new Uint8Array(bytes));
    console.log(`[b4mal plugin] Installed to ${dest}`);
    return dest;
}
