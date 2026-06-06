import { readFileSync, existsSync } from "fs";

export class NxMigrator {
    static migrate(nxJsonPath: string): any[] {
        if (!nxJsonPath.endsWith('.json')) {
            throw new Error("Only static .json configuration files are permitted for security.");
        }
        if (!existsSync(nxJsonPath)) {
            throw new Error(`Nx configuration not found: ${nxJsonPath}`);
        }
        
        const config = JSON.parse(readFileSync(nxJsonPath, "utf-8"));
        const tasks = [];
        
        for (const [taskId, def] of Object.entries(config.targetDefaults || {})) {
            const dependsOn = (def as any).dependsOn || [];
            tasks.push({
                id: taskId,
                cmd: ["npx", "nx", "run", taskId],
                deps: dependsOn.map((d: string) => d.replace('^', '')),
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
