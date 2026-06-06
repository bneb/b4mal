import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import type { Pipeline, Task } from "../schema";

export class PythonIngester {
    ingest(rootDir: string): Pipeline | null {
        const hasReqs = fs.existsSync(path.join(rootDir, "requirements.txt"));
        const hasPoetry = fs.existsSync(path.join(rootDir, "pyproject.toml"));

        if (!hasReqs && !hasPoetry) return null;


        const tasks: Task[] = [];

        // Heuristic: basic install task
        tasks.push({
            id: "install",
            cmd: hasPoetry 
                ? ["poetry", "install"] 
                : ["pip", "install", "-r", "requirements.txt"],
            dependencies: [],
            timeout: 0,
            env: {}
        });

        // Find python source files
        const glob = new Glob("**/*.py");
        const pyFiles = Array.from(glob.scanSync({ cwd: rootDir, absolute: false }))
            .filter(f => !f.includes("venv/") && !f.includes(".tox/"));

        // Heuristic: test task if tests/ exists
        const testFiles = pyFiles.filter(f => f.startsWith("tests/") || f.includes("test_"));
        if (testFiles.length > 0) {
            tasks.push({
                id: "test",
                cmd: hasPoetry ? ["poetry", "run", "pytest"] : ["pytest"],
                dependencies: ["install"],
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
