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
        const config = JSON.parse(rawConfig); // Strictly JSON.parse, no execution
        
        const tasks = [];
        for (const [taskId, def] of Object.entries(config.pipeline || {})) {
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
