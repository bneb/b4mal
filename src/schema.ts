/**
 * B4mal v0.5.0 — Schema Layer
 *
 * The entire "language" of the orchestrator. No YAML. No DSL.
 * Config files are `.ts` modules that export a validated pipeline.
 */
import { z } from "zod";

// ─── Task ────────────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
    /** Unique identifier within the pipeline */
    id: z.string().min(1),

    /** Command + args array (passed directly to Bun.spawn) */
    cmd: z.array(z.string()).min(1),

    /** Additional environment variables merged onto process.env */
    env: z.record(z.string()).default({}),

    /** IDs of tasks that must complete before this one starts */
    dependencies: z.array(z.string()).default([]),

    /** Working directory for the spawned process */
    cwd: z.string().optional(),

    /** Timeout in milliseconds (0 = no timeout) */
    timeout: z.number().int().nonnegative().default(0),
});

export type Task = z.infer<typeof TaskSchema>;

// ─── Task Result ─────────────────────────────────────────────────────────────

export const TaskResultSchema = z.object({
    id: z.string(),
    exitCode: z.number().int(),
    durationMs: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    /** Cache hit type: false = miss, 'content' = exact hash, 'logic' = AST-aware */
    cacheHit: z.union([z.literal(false), z.literal("content"), z.literal("logic")]).default(false),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

// ─── Pipeline ────────────────────────────────────────────────────────────────

export const PipelineSchema = z.object({
    /** Human-readable pipeline name */
    name: z.string().min(1),

    /** Ordered collection of tasks */
    tasks: z.array(TaskSchema).min(1),

    /** Max parallel tasks (0 = unlimited, bounded by OS) */
    concurrency: z.number().int().nonnegative().default(0),

    /** Base environment inherited by all tasks */
    env: z.record(z.string()).default({}),
});

export type Pipeline = z.infer<typeof PipelineSchema>;

// ─── Pipeline Result ─────────────────────────────────────────────────────────

export const PipelineResultSchema = z.object({
    name: z.string(),
    tasks: z.array(TaskResultSchema),
    totalDurationMs: z.number(),
    overheadMs: z.number(),
    success: z.boolean(),
});

export type PipelineResult = z.infer<typeof PipelineResultSchema>;
