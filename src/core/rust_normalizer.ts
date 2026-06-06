/**
 * @file rust_normalizer.ts
 * @description Normalizes Rust syntax trees to provide stable logic hashes across trivial formatting changes.
 */

import { spawnSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

export class RustNormalizer {
    /**
     * Normalize Rust source to its functional logic representation.
     * The output is a "Compressed Logic String" suitable for hashing.
     */
    static normalize(source: string): string {
        const binPath = path.join(
            __dirname,
            "../../crates/rust_normalizer/target/release/rust_normalizer"
        );

        if (!fs.existsSync(binPath)) {
            // Fallback to minimal whitespace stripping if binary not built yet
            return source.replace(/\s+/g, " ").trim();
        }

        const result = spawnSync(binPath, [], {
            input: source,
            encoding: "utf-8",
        });

        if (result.status === 0 && result.stdout) {
            return result.stdout.trim();
        }

        // Fallback on parse error
        return source.replace(/\s+/g, " ").trim();
    }
}

