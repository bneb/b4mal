import { readFileSync, existsSync } from "fs";
import { dirname, join, basename } from "path";
import { Glob } from "bun";
import { load as loadYaml } from "js-yaml";

export class NpmMigrator {
    static migrate(pkgJsonPath: string): any[] {
        if (!existsSync(pkgJsonPath)) {
            throw new Error(`package.json not found: ${pkgJsonPath}`);
        }

        const rootDir = dirname(pkgJsonPath);
        const config = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
        const tasks: any[] = [];

        // Collect scripts from a package.json; prefix with workspace name
        // when we're scanning a sub-package.
        const collectScripts = (pkgPath: string, prefix = "") => {
            if (!existsSync(pkgPath)) return;
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            for (const taskId of Object.keys(pkg.scripts || {})) {
                const id = prefix ? `${prefix}:${taskId}` : taskId;
                tasks.push({
                    id,
                    cmd: ["npm", "run", taskId, "--prefix", dirname(pkgPath)],
                    deps: [],
                    claims: [], reads: [], writes: [], envReads: [], envWrites: [],
                });
            }
        };

        // 1. Root scripts
        collectScripts(pkgJsonPath);

        // 2. If root had scripts, return them as-is (simple project, not a monorepo)
        if (tasks.length > 0) return tasks;

        // 3. Root had no scripts — scan workspace packages
        const workspaceGlobs = this.readWorkspaceGlobs(rootDir);
        for (const pattern of workspaceGlobs) {
            const glob = new Glob(pattern);
            // Glob for package.json files within the workspace pattern
            const pkgGlob = new Glob(`${pattern}/package.json`);
            for (const match of pkgGlob.scanSync({ cwd: rootDir, absolute: false })) {
                // Derive workspace name from directory name
                const pkgDir = dirname(match);
                const name = pkgDir === "." ? basename(rootDir) : pkgDir.replace(/\//g, "-");
                collectScripts(join(rootDir, match), name);
            }
        }

        // 4. If still no scripts, check for a single sub-package pattern
        // (some monorepos have workspaces but no root scripts AND sub-packages
        //  with their own scripts — we already scanned them above)
        return tasks;
    }

    /**
     * Read workspace package globs from pnpm-workspace.yaml or
     * package.json `workspaces` field.
     */
    private static readWorkspaceGlobs(rootDir: string): string[] {
        const patterns: string[] = [];

        // pnpm workspace
        const pnpmYaml = join(rootDir, "pnpm-workspace.yaml");
        if (existsSync(pnpmYaml)) {
            try {
                const yaml: any = loadYaml(readFileSync(pnpmYaml, "utf-8"));
                if (Array.isArray(yaml?.packages)) {
                    patterns.push(...yaml.packages);
                }
            } catch { /* invalid YAML, skip */ }
        }

        // npm / yarn workspaces (package.json "workspaces" field)
        const pkgJson = join(rootDir, "package.json");
        if (existsSync(pkgJson)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
                if (Array.isArray(pkg.workspaces)) {
                    patterns.push(...pkg.workspaces);
                }
            } catch { /* invalid JSON, skip */ }
        }

        return patterns;
    }
}
