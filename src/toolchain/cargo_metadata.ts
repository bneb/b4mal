// B4mal v4.0.0 — Cargo Metadata Parser
//
// Parses the JSON output of `cargo metadata --format-version=1`
// to build a CrateGraph: nodes are crates, edges are dependencies,
// with workspace membership detection.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CrateInfo {
    name: string;
    version: string;
    id: string;
    manifestPath: string;
    isWorkspaceMember: boolean;
    isExternal: boolean;
    targets: { name: string; kind: string[]; srcPath: string }[];
    dependencies: string[];
}

export interface CrateGraph {
    crates: CrateInfo[];
    workspaceRoot: string;
    targetDirectory: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export class CargoMetadataParser {
    /**
     * Parse raw `cargo metadata` JSON output into a CrateGraph.
     */
    parse(metadata: any): CrateGraph {
        const workspaceMembers = new Set(metadata.workspace_members ?? []);

        const crates: CrateInfo[] = (metadata.packages ?? []).map((pkg: any) => {
            const isWorkspaceMember = workspaceMembers.has(pkg.id);

            return {
                name: pkg.name,
                version: pkg.version,
                id: pkg.id,
                manifestPath: pkg.manifest_path,
                isWorkspaceMember,
                isExternal: pkg.source !== null,
                targets: (pkg.targets ?? []).map((t: any) => ({
                    name: t.name,
                    kind: t.kind,
                    srcPath: t.src_path,
                })),
                dependencies: (pkg.dependencies ?? []).map((d: any) => d.name),
            };
        });

        return {
            crates,
            workspaceRoot: metadata.workspace_root ?? "",
            targetDirectory: metadata.target_directory ?? "",
        };
    }

    /**
     * Run `cargo metadata` and parse the output.
     * Returns the crate graph for the project at the given path.
     */
    async fromProject(projectPath: string): Promise<CrateGraph> {
        const proc = Bun.spawn(
            ["cargo", "metadata", "--format-version=1", "--no-deps"],
            {
                cwd: projectPath,
                stdout: "pipe",
                stderr: "pipe",
            },
        );

        const output = await new Response(proc.stdout).text();
        await proc.exited;

        const metadata = JSON.parse(output);
        return this.parse(metadata);
    }
}
