import { readFileSync, existsSync } from "fs";

export class NpmMigrator {
    static migrate(pkgJsonPath: string): any[] {
        if (!existsSync(pkgJsonPath)) {
            throw new Error(`package.json not found: ${pkgJsonPath}`);
        }
        
        const config = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        const tasks = [];
        
        for (const taskId of Object.keys(config.scripts || {})) {
            tasks.push({
                id: taskId,
                cmd: ["npm", "run", taskId],
                deps: [],
                claims: [], reads: [], writes: [], envReads: [], envWrites: []
            });
        }
        return tasks;
    }
}
