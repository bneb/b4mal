/**
 * @file logic_hasher.ts
 * @description Computes structural hashes of task logic to enable L1/L2 cache keying.
 */

import { RustNormalizer } from "./rust_normalizer";

const transpiler = new Bun.Transpiler({
    loader: "ts",
    // Dead code elimination and tree shaking strip unused constructs
    trimUnusedImports: true,
});

/**
 * Generate a logic-aware hash of source code.
 *
 * Invariant to:
 *   - Comments (line, block, JSDoc)
 *   - Whitespace (indentation, blank lines, tabs vs spaces)
 *   - Type annotations (TS → JS erasure)
 *   - Interface/type-only declarations
 *
 * Sensitive to:
 *   - Variable/function names
 *   - Logic changes (different values, added statements)
 *   - Control flow
 */
export async function generateLogicHashFromFile(filePath: string): Promise<string> {
    const fs = require("fs");
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stats = fs.fstatSync(fd);
        if (stats.size > 10 * 1024 * 1024) {
            throw new Error("File too large for logic hashing");
        }
        
        const buffer = Buffer.alloc(stats.size);
        let bytesRead = 0;
        let pos = 0;
        while ((bytesRead = fs.readSync(fd, buffer, pos, stats.size - pos, pos)) > 0) {
            pos += bytesRead;
        }
        
        const code = buffer.toString("utf8", 0, pos);
        return generateLogicHash(code, filePath);
    } finally {
        fs.closeSync(fd);
    }
}

export async function generateLogicHash(code: string, filePath?: string): Promise<string> {
    try {
        let normalized: string;

        if (filePath && filePath.endsWith(".rs")) {
            const normalized = RustNormalizer.normalize(code);
            const hasher = new Bun.CryptoHasher("sha256");
            hasher.update(normalized);
            return hasher.digest("hex");
        } else {
            const transpiled = transpiler.transformSync(code);
            
            const buf = Buffer.from(transpiled);
            const hasher = new Bun.CryptoHasher("sha256");
            let inSpace = false;
            let lastStart = 0;
            for (let i = 0; i < buf.length; i++) {
                const b = buf[i];
                if (b <= 32 && (b === 32 || b === 9 || b === 10 || b === 13)) {
                    if (!inSpace) {
                        hasher.update(buf.subarray(lastStart, i));
                        hasher.update(" ");
                        inSpace = true;
                    }
                } else {
                    if (inSpace) {
                        lastStart = i;
                        inSpace = false;
                    }
                }
            }
            if (!inSpace) {
                hasher.update(buf.subarray(lastStart));
            }
            return hasher.digest("hex");
        }
    } catch {
        // Fallback for non-TS/JS content (JSON, YAML, Markdown, etc.)
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(code);
        return hasher.digest("hex");
    }
}

/**
 * Check if a file extension is eligible for logic hashing.
 * Non-code files always use content hashing.
 */
export function isLogicHashable(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase();
    return ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "mts" || ext === "mjs" || ext === "rs";
}
