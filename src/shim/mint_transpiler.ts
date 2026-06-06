/**
 * B4mal — RWX Mint Transpiler (The Core Shim)
 *
 * Ingests RWX Mint YAML task definitions and outputs
 * type-safe b4mal Pipeline configurations.
 */
import { parse as parseYaml } from "yaml";
import { PipelineSchema, type Pipeline } from "../schema";
import { generateForecast, type ForecastResult } from "./forecaster";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TranspileResult {
    pipeline: Pipeline;
    typescript: string;
    warnings: string[];
    forecast: ForecastResult;
}

interface RawMintTask {
    key: string;
    run: string;
    after?: string[];
    use?: string[];
    env?: Record<string, string>;
}

interface RawMintPipeline {
    key?: string;
    values?: Record<string, string>;
    tasks: RawMintTask[];
}

// ─── Transpiler ──────────────────────────────────────────────────────────────

export class MintTranspiler {
    /**
     * Transpile RWX Mint YAML into a b4mal Pipeline.
     *
     * Mapping:
     *   RWX task.key       → b4mal task.id
     *   RWX task.run       → b4mal task.cmd (split or sh -c wrapped)
     *   RWX task.after/use → b4mal task.dependencies
     *   RWX task.env        → b4mal task.env (with ${{ values.* }} mapping)
     *   RWX pipeline.key    → b4mal pipeline.name
     */
    static transpile(yamlContent: string): TranspileResult {
        const raw = parseYaml(yamlContent) as RawMintPipeline;
        const warnings: string[] = [];
        const values = raw.values || {};

        const tasks = raw.tasks.map((t) => {
            // ── Command Normalization ─────────────────────────────────
            const cmd = this.normalizeCommand(t.run);

            // ── Dependency Mapping ────────────────────────────────────
            // RWX uses 'after' for order and 'use' for artifacts/order.
            // B4mal treats both as DAG dependencies.
            const dependencies = Array.from(new Set([
                ...(t.after || []),
                ...(t.use || [])
            ]));

            // ── Environment Variable Mapping ──────────────────────────
            const env: Record<string, string> = {};
            if (t.env) {
                for (const [key, value] of Object.entries(t.env)) {
                    env[key] = this.mapVariable(value, values, warnings);
                }
            }

            // Scan run command for ${{ values.* }} placeholders too
            const cmdStr = typeof t.run === "string" ? t.run : "";
            const cmdPlaceholders = cmdStr.match(/\$\{\{\s*values\.(\w[\w.-]*)\s*\}\}/g);
            if (cmdPlaceholders) {
                for (const p of cmdPlaceholders) {
                    const varName = p.match(/values\.(\w[\w.-]*)/)?.[1] || "";
                    if (!warnings.some((w) => w.includes(`values.${varName}`))) {
                        warnings.push(
                            `[WARN] RWX placeholder $\{{ values.${varName} }} found in command. ` +
                            `Mapped to B4MAL_${varName.toUpperCase().replace(/[.-]/g, "_")} env var.`
                        );
                    }
                }
            }

            return {
                id: t.key,
                cmd,
                env,
                dependencies,
            };
        });

        const pipelineName = raw.key || "migrated-pipeline";

        // Validate through Zod
        const pipeline = PipelineSchema.parse({
            name: pipelineName,
            tasks,
        });

        // Generate TypeScript source
        const typescript = this.generateTypeScript(pipelineName, tasks);

        // Generate Core Forecast
        const forecast = generateForecast(tasks.length);

        return { pipeline, typescript, warnings, forecast };
    }

    /**
     * Split a run command into a cmd array.
     * Composite commands (containing &&, ||, |, ;) are wrapped in sh -c.
     */
    private static normalizeCommand(run: string): string[] {
        const compositeOperators = ["&&", "||", "|", ";"];
        const isComposite = compositeOperators.some((op) => run.includes(op));

        if (isComposite) {
            return ["sh", "-c", run];
        }

        return run.split(/\s+/).filter(Boolean);
    }

    /**
     * Map ${{ values.* }} placeholders to B4MAL_ prefixed env vars.
     * Static values pass through unchanged.
     */
    private static mapVariable(
        value: string,
        values: Record<string, string>,
        warnings: string[]
    ): string {
        const placeholderRegex = /\$\{\{\s*values\.(\w[\w.-]*)\s*\}\}/g;
        let match: RegExpExecArray | null;
        let result = value;

        while ((match = placeholderRegex.exec(value)) !== null) {
            const varName = match[1];
            const envVarName = `B4MAL_${varName.toUpperCase().replace(/[.-]/g, "_")}`;

            // Replace placeholder with env var reference
            result = result.replace(match[0], `\${${envVarName}}`);

            if (!warnings.some((w) => w.includes(`values.${varName}`))) {
                warnings.push(
                    `[WARN] RWX placeholder $\{{ values.${varName} }} mapped to ${envVarName}. ` +
                    `Set this variable in your b4mal pipeline env or shell.`
                );
            }
        }

        return result;
    }

    /**
     * Generate the b4mal TypeScript pipeline source.
     */
    private static generateTypeScript(
        name: string,
        tasks: Array<{ id: string; cmd: string[]; env: Record<string, string>; dependencies: string[] }>
    ): string {
        const taskDefs = tasks
            .map((t) => {
                const envStr = Object.keys(t.env).length > 0
                    ? `\n        env: ${JSON.stringify(t.env)},`
                    : "";
                const depsStr = t.dependencies.length > 0
                    ? `\n        dependencies: ${JSON.stringify(t.dependencies)},`
                    : "";
                return `    {
        id: "${t.id}",
        cmd: ${JSON.stringify(t.cmd)},${envStr}${depsStr}
    }`;
            })
            .join(",\n");

        return `/**
 * Auto-generated by b4mal Core Shim
 * Migrated from RWX Mint → b4mal Pipeline
 */
import { PipelineSchema } from "b4mal/schema";

export default PipelineSchema.parse({
    name: "${name}",
    tasks: [
${taskDefs}
    ],
});
`;
    }
}
