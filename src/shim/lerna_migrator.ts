import { readFileSync, existsSync } from "fs";

export class LernaMigrator {
    static migrate(lernaJsonPath: string): any[] {
        if (!lernaJsonPath.endsWith('.json')) {
            throw new Error("Only static .json configuration files are permitted for security.");
        }
        if (!existsSync(lernaJsonPath)) {
            throw new Error(`Lerna configuration not found: ${lernaJsonPath}`);
        }
        
        return [
            {
                id: "build",
                cmd: ["npx", "lerna", "run", "build"],
                deps: [],
                claims: [], reads: [], writes: [], envReads: [], envWrites: []
            },
            {
                id: "test",
                cmd: ["npx", "lerna", "run", "test"],
                deps: ["build"],
                claims: [], reads: [], writes: [], envReads: [], envWrites: []
            }
        ];
    }
}
