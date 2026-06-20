import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import type { Pipeline, Task } from "../schema";

/**
 * Detects Cargo.toml and generates standard Rust build/test tasks.
 */
export class CargoIngester {
    ingest(rootDir: string): Pipeline | null {
        const hasCargoToml = fs.existsSync(path.join(rootDir, "Cargo.toml"));
        if (!hasCargoToml) return null;

        const tasks: Task[] = [];

        tasks.push({
            id: "build",
            cmd: ["cargo", "build"],
            dependencies: [],
            timeout: 0,
            env: {},
        });

        // Check for test files or a test harness
        const glob = new Glob("**/*.rs");
        const rsFiles = Array.from(glob.scanSync({ cwd: rootDir, absolute: false }))
            .filter(f => !f.includes("target/"));

        tasks.push({
            id: "test",
            cmd: ["cargo", "test"],
            dependencies: ["build"],
            timeout: 0,
            env: {},
        });

        // If benchmark files exist, add a bench task
        const benchFiles = rsFiles.filter(f =>
            f.includes("benches/") || f.endsWith("_bench.rs")
        );
        if (benchFiles.length > 0) {
            tasks.push({
                id: "bench",
                cmd: ["cargo", "bench"],
                dependencies: ["build"],
                timeout: 0,
                env: {},
            });
        }

        // If clippy is likely available, add a lint task
        tasks.push({
            id: "lint",
            cmd: ["cargo", "clippy", "--", "-D", "warnings"],
            dependencies: [],
            timeout: 0,
            env: {},
        });

        return {
            name: this.deriveName(rootDir),
            tasks,
            concurrency: 0,
            env: {},
        };
    }

    private deriveName(rootDir: string): string {
        try {
            const cargoToml = fs.readFileSync(path.join(rootDir, "Cargo.toml"), "utf-8");
            const m = cargoToml.match(/name\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        } catch {}
        return path.basename(rootDir);
    }
}
