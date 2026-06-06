/**
 * @file audit_engine.ts
 * @description Drives the continuous validation pipeline for state consistency and invariant checking.
 */

const transpiler = new Bun.Transpiler({ loader: "ts" });

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiffClassification {
    isTaxEvent: boolean;
    reason: string;
}

export interface AuditReport {
    totalCommits: number;
    totalFilesAnalyzed: number;
    taxEvents: number;
    logicChanges: number;
    timeRecoveredSeconds: number;
    timeRecoveredFormatted: string;
    taxRate: number; // percentage of commits that were tax events
}

export interface AuditOptions {
    cwd?: string;
    limit?: number;
    avgTaskSeconds?: number;
}

// ─── Core: classifyDiff ──────────────────────────────────────────────────────

/**
 * Classify a before/after file pair as a Tax Event or a Logic Change.
 *
 * Tax Event: The transpiled (comment/type-stripped) output is identical,
 * meaning the change was purely aesthetic (comments, types, whitespace).
 *
 * Logic Change: The transpiled output differs, meaning executable
 * behavior has changed.
 */
export function classifyDiff(before: string, after: string): DiffClassification {
    // Fast path: identical raw content
    if (before === after) {
        return { isTaxEvent: false, reason: "identical — no change detected" };
    }

    let transpiledBefore: string;
    let transpiledAfter: string;

    try {
        transpiledBefore = transpiler.transformSync(before).trim();
    } catch {
        transpiledBefore = before.trim();
    }

    try {
        transpiledAfter = transpiler.transformSync(after).trim();
    } catch {
        transpiledAfter = after.trim();
    }

    // If transpiled output is the same, all changes were comments/types/whitespace
    if (transpiledBefore === transpiledAfter) {
        // Determine what kind of aesthetic change
        const hasCommentDiff = countComments(after) !== countComments(before);
        const hasTypeDiff = hasTypeChanges(before, after);

        let reason = "comment/type/whitespace-only change (logic-invariant)";
        if (hasCommentDiff && hasTypeDiff) {
            reason = "comment + type annotation change (logic-invariant)";
        } else if (hasCommentDiff) {
            reason = "comment-only change (logic-invariant)";
        } else if (hasTypeDiff) {
            reason = "type annotation change (logic-invariant)";
        }

        return { isTaxEvent: true, reason };
    }

    return { isTaxEvent: false, reason: "logic change detected" };
}

function countComments(source: string): number {
    const singleLine = (source.match(/\/\/.*/g) || []).length;
    const multiLine = (source.match(/\/\*[\s\S]*?\*\//g) || []).length;
    return singleLine + multiLine;
}

function hasTypeChanges(before: string, after: string): boolean {
    const typeKeywords = /\b(interface|type|as|readonly)\b/g;
    const beforeCount = (before.match(typeKeywords) || []).length;
    const afterCount = (after.match(typeKeywords) || []).length;
    return beforeCount !== afterCount;
}

// ─── Git Integration ─────────────────────────────────────────────────────────

export class AuditEngine {
    /**
     * Scan git history to find logic-invariant commits.
     */
    static async run(options: AuditOptions = {}): Promise<AuditReport> {
        const cwd = options.cwd ?? process.cwd();
        const limit = options.limit ?? 50;
        const avgTaskSeconds = options.avgTaskSeconds ?? 300;

        // Get commit list
        const commits = await this.getCommits(cwd, limit);

        let taxEvents = 0;
        let logicChanges = 0;
        let totalFilesAnalyzed = 0;

        for (const commit of commits) {
            const changedFiles = await this.getChangedFiles(cwd, commit);
            const tsFiles = changedFiles.filter(f => f.endsWith(".ts"));

            for (const file of tsFiles) {
                totalFilesAnalyzed++;

                const before = await this.getFileAtCommit(cwd, `${commit}^`, file);
                const after = await this.getFileAtCommit(cwd, commit, file);

                if (before === null || after === null) continue;

                const classification = classifyDiff(before, after);
                if (classification.isTaxEvent) {
                    taxEvents++;
                } else if (classification.reason !== "identical — no change detected") {
                    logicChanges++;
                }
            }
        }

        const timeRecoveredSeconds = taxEvents * avgTaskSeconds;
        const hours = timeRecoveredSeconds / 3600;

        return {
            totalCommits: commits.length,
            totalFilesAnalyzed,
            taxEvents,
            logicChanges,
            timeRecoveredSeconds,
            timeRecoveredFormatted: hours >= 1
                ? `${hours.toFixed(1)} hours`
                : `${(timeRecoveredSeconds / 60).toFixed(1)} minutes`,
            taxRate: commits.length > 0 ? (taxEvents / Math.max(1, totalFilesAnalyzed)) * 100 : 0,
        };
    }

    private static async getCommits(cwd: string, limit: number): Promise<string[]> {
        try {
            const proc = Bun.spawn(
                ["git", "rev-list", "--max-count", limit.toString(), "HEAD"],
                { cwd, stdout: "pipe", stderr: "pipe" }
            );
            const output = await new Response(proc.stdout).text();
            await proc.exited;
            return output.trim().split("\n").filter(Boolean);
        } catch {
            return [];
        }
    }

    private static async getChangedFiles(cwd: string, commit: string): Promise<string[]> {
        try {
            const proc = Bun.spawn(
                ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", commit],
                { cwd, stdout: "pipe", stderr: "pipe" }
            );
            const output = await new Response(proc.stdout).text();
            await proc.exited;
            return output.trim().split("\n").filter(Boolean);
        } catch {
            return [];
        }
    }

    private static async getFileAtCommit(
        cwd: string,
        ref: string,
        file: string
    ): Promise<string | null> {
        try {
            const proc = Bun.spawn(
                ["git", "show", `${ref}:${file}`],
                { cwd, stdout: "pipe", stderr: "pipe" }
            );
            const output = await new Response(proc.stdout).text();
            const exitCode = await proc.exited;
            return exitCode === 0 ? output : null;
        } catch {
            return null;
        }
    }
}
