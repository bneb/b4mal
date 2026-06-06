import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import type { Pipeline, Task } from "../schema";

export class GoIngester {
    ingest(rootDir: string): Pipeline | null {
        const hasGoMod = fs.existsSync(path.join(rootDir, "go.mod"));

        if (!hasGoMod) return null;


        const tasks: Task[] = [];

        tasks.push({
            id: "build",
            cmd: ["go", "build", "./..."],
            dependencies: [],
            timeout: 0,
            env: {}
        });

        const glob = new Glob("**/*.go");
        const goFiles = Array.from(glob.scanSync({ cwd: rootDir, absolute: false }))
            .filter(f => !f.includes("vendor/"));

        const testFiles = goFiles.filter(f => f.endsWith("_test.go"));

        if (testFiles.length > 0) {
            tasks.push({
                id: "test",
                cmd: ["go", "test", "./..."],
                dependencies: ["build"],
                timeout: 0,
                env: {}
            });
        }

        return {
            name: path.basename(rootDir),
            tasks,
            concurrency: 0,
            env: {}
        };
    }
}
