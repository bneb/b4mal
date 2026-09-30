import { readFileSync, existsSync } from "fs";

/**
 * Normalize an Nx target `inputs`/`outputs` entry into a plain string.
 *
 * Nx accepts object descriptors, not just strings:
 *
 *   "src/[glob].ts"                                    (already a string)
 *   { "fileset": "{projectRoot}/src/[glob]" }           (a file glob)
 *   { "env": "NODE_ENV" }                              (an env var name)
 *
 * The b4mal config schema requires `inputs`/`outputs` to be string arrays, so an
 * object entry would fail validation on load. Extract the filesystem meaning
 * (fileset/glob/root) and drop descriptors that carry none (env, and unknown
 * shapes) rather than emitting a value that cannot be expressed.
 */
export function normalizeNxPathEntry(entry: unknown): string | null {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const candidate = obj.fileset ?? obj.glob ?? obj.root ?? obj.input ?? obj.output;
        if (typeof candidate === "string") {
            // Strip Nx's {projectRoot}/ interpolation to the literal token; b4mal
            // paths are project-relative.
            return candidate.replace(/\{projectRoot\}\/?/g, "");
        }
        // { env: "FOO" } and any other descriptor carry no filesystem resource.
        return null;
    }
    return null;
}

export function normalizeNxPathList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
        const normalized = normalizeNxPathEntry(entry);
        if (normalized) out.push(normalized);
    }
    return out;
}

/**
 * Normalize an Nx `dependsOn` entry to a task id.
 *
 * Nx accepts two shapes and both appear in real workspaces:
 *
 *   "build"                                            (plain target)
 *   "^build"                                           (same target on dependencies)
 *   { target: "build", projects: ["directory:packages/*"] }
 *
 * Only the string form was handled. A workspace using the object form made
 * `d.replace` throw `TypeError: d.replace is not a function`, which surfaced as a
 * failed migration — and the caller falls back to AST discovery, emitting one
 * placeholder task per file. TanStack/query hit exactly this: 565 placeholder
 * tasks from a single unhandled object.
 *
 * Returns null for anything unrecognisable so one malformed entry cannot fail
 * the whole migration.
 */
export function normalizeNxDependency(entry: unknown): string | null {
    if (typeof entry === "string") {
        const name = entry.replace(/^\^/, "").trim();
        return name.length > 0 ? name : null;
    }

    if (entry && typeof entry === "object" && "target" in entry) {
        const target = (entry as { target?: unknown }).target;
        if (typeof target === "string") {
            const name = target.replace(/^\^/, "").trim();
            return name.length > 0 ? name : null;
        }
    }

    return null;
}

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

            // Deduplicate while preserving declaration order.
            const deps = [
                ...new Set(
                    (Array.isArray(dependsOn) ? dependsOn : [])
                        .map(normalizeNxDependency)
                        .filter((d): d is string => d !== null),
                ),
            ];

            tasks.push({
                id: taskId,
                cmd: ["npx", "nx", "run", taskId],
                deps,
                claims: [],
                reads: normalizeNxPathList((def as any).inputs),
                writes: normalizeNxPathList((def as any).outputs),
                envReads: [],
                envWrites: []
            });
        }
        return tasks;
    }
}
