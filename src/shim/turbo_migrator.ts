import { readFileSync, existsSync } from "fs";

export class TurboMigrator {
    /**
     * Translates a turbo.json file into a b4mal-compatible task graph.
     */
    static migrate(turboJsonPath: string): any[] {
        // RED TEAM MITIGATION: Strict static parsing.
        // We explicitly use JSON.parse and avoid any dynamic require() or eval()
        // even if the configuration is a .js or .ts file (which is rejected).
        if (!turboJsonPath.endsWith('.json')) {
            throw new Error("Only static .json configuration files are permitted for security. Dynamic JS configs are rejected to prevent Arbitrary Code Execution.");
        }

        if (!existsSync(turboJsonPath)) {
            throw new Error(`Turbo configuration not found: ${turboJsonPath}`);
        }

        const rawConfig = readFileSync(turboJsonPath, "utf-8");
        // Turborepo configs sometimes use JSON-with-comments (JSONC).
        // Try strict parse first; if it fails, strip comments and retry.
        // Only strip // on lines where it appears before any " (avoids
        // matching // inside string values like "//#quality").
        let config: any;
        try {
            config = JSON.parse(rawConfig);
        } catch {
            const sansComments = rawConfig
                .replace(/\/\*[\s\S]*?\*\//g, "")           // block comments
                .replace(/^\s*\/\/.*$/gm, "");              // full-line comments only
            config = JSON.parse(sansComments);
        }
        
        // Turborepo v1 used "pipeline", v2+ uses "tasks"
        const pipeline = config.tasks || config.pipeline || {};
        const tasks = [];
        for (const [taskId, def] of Object.entries(pipeline)) {
            tasks.push({
                id: taskId,
                cmd: ["npm", "run", taskId],
                deps: ((def as any).dependsOn || []).map((d: string) => d.replace('^', '')),
                claims: [],
                reads: (def as any).inputs || [],
                writes: (def as any).outputs || [],
                envReads: [],
                envWrites: []
            });
        }
        return tasks;
    }
}
