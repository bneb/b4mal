import type { Pipeline, Task } from "../schema";
import * as fs from "fs";
import * as path from "path";
import { Glob } from "bun";
import * as yaml from "js-yaml";

export interface TurboConfig {
    pipeline?: Record<string, {
        dependsOn?: string[];
        outputs?: string[];
        inputs?: string[];
    }>;
}

export interface WorkspacePackage {
    name: string;
    path: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

export class TurboIngester {
    /**
     * Parse from a project root.
     */
    ingest(projectRoot: string): Pipeline {
        const turboPath = path.join(projectRoot, "turbo.json");
        const rootPkgPath = path.join(projectRoot, "package.json");

        if (!fs.existsSync(turboPath) || !fs.existsSync(rootPkgPath)) {
            throw new Error("Missing turbo.json or package.json in root");
        }

        const turboJson = JSON.parse(fs.readFileSync(turboPath, "utf-8")) as TurboConfig;
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));

        const packages: WorkspacePackage[] = [];
        let workspaces = rootPkg.workspaces || [];

        // Fallback to pnpm-workspace.yaml if package.json workspaces is missing
        if (!Array.isArray(workspaces) || workspaces.length === 0) {
            const pnpmWorkspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
            if (fs.existsSync(pnpmWorkspacePath)) {
                try {
                    const doc = yaml.load(fs.readFileSync(pnpmWorkspacePath, "utf-8")) as any;
                    if (doc && Array.isArray(doc.packages)) {
                        workspaces = doc.packages;
                    }
                } catch (e) {
                    console.warn("Failed to parse pnpm-workspace.yaml", e);
                }
            }
        }

        // For simplicity, handle basic globbing like 'packages/*'
        // and resolve their package.json files
        for (const ws of workspaces) {
            const glob = new Glob(ws);
            const matches = Array.from(glob.scanSync({ cwd: projectRoot, absolute: true, onlyFiles: false }));
            for (const match of matches) {
                const stat = fs.statSync(match);
                if (stat.isDirectory()) {
                    const pkgPath = path.join(match, "package.json");
                    if (fs.existsSync(pkgPath)) {
                        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                        packages.push({
                            name: pkgJson.name,
                            path: path.relative(projectRoot, match) || ".",
                            scripts: pkgJson.scripts,
                            dependencies: pkgJson.dependencies,
                            devDependencies: pkgJson.devDependencies
                        });
                    }
                }
            }
        }

        return this.ingestMocked(turboJson, rootPkg, packages);
    }

    /**
     * Ingest mocked data for unit testing.
     */
    ingestMocked(turboJson: TurboConfig, rootPackageJson: any, packages: WorkspacePackage[]): Pipeline {
        const tasks: Task[] = [];
        
        // Build an adjacency list of package dependencies
        // package name -> array of package names it depends on
        const packageDeps = new Map<string, string[]>();
        
        for (const pkg of packages) {
            const deps = [];
            if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies));
            if (pkg.devDependencies) deps.push(...Object.keys(pkg.devDependencies));
            
            // Filter to only internal workspace packages
            const internalDeps = deps.filter(dep => packages.some(p => p.name === dep));
            packageDeps.set(pkg.name, internalDeps);
        }

        const pipelineConfig = turboJson.pipeline || {};

        // Iterate over all scripts in turbo config
        for (const [scriptName, scriptConfig] of Object.entries(pipelineConfig)) {
            // For each package, if it has this script, create a task
            for (const pkg of packages) {
                if (!pkg.scripts || !pkg.scripts[scriptName]) {
                    continue; // This package doesn't implement this script
                }

                const taskId = `${pkg.name}:${scriptName}`;
                const dependencies: string[] = [];

                if (scriptConfig.dependsOn) {
                    for (const dep of scriptConfig.dependsOn) {
                        if (dep.startsWith("^")) {
                            // Topological dependency: depends on this script running in dependencies
                            const targetScript = dep.slice(1);
                            const pkgDependencies = packageDeps.get(pkg.name) || [];
                            for (const pDep of pkgDependencies) {
                                // Only add if the dependency package actually implements the target script
                                const pDepInfo = packages.find(p => p.name === pDep);
                                if (pDepInfo?.scripts?.[targetScript]) {
                                    dependencies.push(`${pDep}:${targetScript}`);
                                }
                            }
                        } else {
                            // Same-package dependency (e.g. test depends on build)
                            if (pkg.scripts[dep]) {
                                dependencies.push(`${pkg.name}:${dep}`);
                            }
                        }
                    }
                }

                tasks.push({
                    id: taskId,
                    cmd: ["bun", "run", scriptName], // Simple mapping for now
                    cwd: pkg.path,
                    env: {},
                    dependencies,
                    timeout: 0
                });
            }
        }

        return {
            name: "Auto-generated from Turborepo",
            tasks,
            concurrency: 0,
            env: {}
        };
    }
}
