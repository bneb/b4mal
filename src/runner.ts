/**
 * B4mal v0.5.0 — Task Runner
 *
 * Process isolation via Bun.spawn.
 * Nanosecond-precision timing via Bun.nanoseconds().
 */
import type { Task, TaskResult } from "./schema";
import { SandboxEngine } from "./guard/sandbox";

export async function runTask(task: Task, baseEnv: Record<string, string> = {}): Promise<TaskResult> {
    const startNs = Bun.nanoseconds();

    const mergedEnv = { ...process.env, ...baseEnv, ...task.env };

    const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
        env: mergedEnv,
        stdout: "pipe",
        stderr: "pipe",
        cwd: task.cwd,
    };

    // Wrap command with sandbox if task is strict (or if we enable strict globally later)
    // For now, assume we enforce strict sandboxing on all tasks that specify it, or by default
    const isStrict = task.env?.["B4MAL_STRICT_SANDBOX"] === "1";
    const finalCmd = SandboxEngine.wrapCommand(task.cmd, {
        strict: isStrict,
        writablePath: task.cwd,
        denyNetwork: false, // Could be derived from task claims in the future
    });

    const proc = Bun.spawn(finalCmd, spawnOpts);

    // If timeout is set, race against an abort
    let exitCode: number;
    if (task.timeout > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                proc.kill();
                reject(new Error(`Task "${task.id}" timed out after ${task.timeout}ms`));
            }, task.timeout);
        });

        try {
            exitCode = await Promise.race([proc.exited, timeoutPromise]);
        } catch (err) {
            const durationMs = (Bun.nanoseconds() - startNs) / 1e6;
            return {
                id: task.id,
                exitCode: 124,
                durationMs,
                stdout: "",
                stderr: err instanceof Error ? err.message : "timeout",
                cacheHit: false,
            };
        }
    } else {
        exitCode = await proc.exited;
    }

    const stdoutStream = proc.stdout;
    const stderrStream = proc.stderr;
    const stdout = stdoutStream ? await new Response(stdoutStream as ReadableStream).text() : "";
    const stderr = stderrStream ? await new Response(stderrStream as ReadableStream).text() : "";
    const durationMs = (Bun.nanoseconds() - startNs) / 1e6;

    return {
        id: task.id,
        exitCode,
        durationMs,
        stdout,
        stderr,
        cacheHit: false,
    };
}
