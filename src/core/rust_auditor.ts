/**
 * @file rust_auditor.ts
 * @description Parses Rust macros and dependencies to determine strict execution boundaries for Cargo projects.
 */

import { stripForLanguage } from "./comment_stripper";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaxEvent {
    commit: string;
    file: string;
    reason: string;
}

export interface AuditResult {
    commitsScanned: number;
    filesAnalyzed: number;
    taxEvents: number;
    logicChanges: number;
    taxRate: number;           // percentage
    totalSavedSeconds: number;
    events: TaxEvent[];
    elapsedMs: number;
}

export interface ScanOptions {
    limit?: number;
    avgCompileSeconds?: number;
}

// ─── Rust Auditor ────────────────────────────────────────────────────────────

export class RustAuditor {
    private static readonly DEFAULT_COMPILE_SECONDS = 300;

    /**
     * Scan git history for logic-invariant commits in .rs files.
     * Uses RustNormalizer for precise logic comparison.
     */
    static async scan(repoDir: string, options: ScanOptions = {}): Promise<AuditResult> {
        const limit = options.limit ?? 100;
        const avgCompile = options.avgCompileSeconds ?? this.DEFAULT_COMPILE_SECONDS;
        const start = performance.now();

        // 1. Get commit list
        const commits = await this.getCommits(repoDir, limit);

        let filesAnalyzed = 0;
        let taxEvents = 0;
        let logicChanges = 0;
        const events: TaxEvent[] = [];

        // 2. For each commit, check changed .rs files
        for (const commit of commits) {
            const changedFiles = await this.getChangedFiles(repoDir, commit);

            for (const file of changedFiles) {
                // Only audit Rust files
                if (!file.endsWith(".rs")) continue;

                filesAnalyzed++;

                // Get before/after content
                const before = await this.getFileAt(repoDir, `${commit}^`, file);
                const after = await this.getFileAt(repoDir, commit, file);

                // Skip new files or deleted files
                if (before === null || after === null) continue;

                // Skip if content is identical (no actual change)
                if (before === after) continue;

                // Normalize with comment_stripper
                const normBefore = stripForLanguage(before, "rust");
                const normAfter = stripForLanguage(after, "rust");

                if (normBefore === normAfter) {
                    // TAX EVENT: Content changed but logic is identical
                    taxEvents++;
                    events.push({
                        commit: commit.slice(0, 7),
                        file,
                        reason: this.classifyChange(before, after),
                    });
                } else {
                    logicChanges++;
                }
            }
        }

        const totalAnalyzed = taxEvents + logicChanges;
        const taxRate = totalAnalyzed > 0 ? (taxEvents / totalAnalyzed) * 100 : 0;
        const totalSavedSeconds = taxEvents * avgCompile;
        const elapsedMs = performance.now() - start;

        return {
            commitsScanned: commits.length,
            filesAnalyzed,
            taxEvents,
            logicChanges,
            taxRate,
            totalSavedSeconds,
            events,
            elapsedMs,
        };
    }

    // ─── Git Plumbing ────────────────────────────────────────────────────

    private static async getCommits(cwd: string, limit: number): Promise<string[]> {
        const proc = Bun.spawn(
            ["git", "rev-list", "--max-count", limit.toString(), "HEAD"],
            { cwd, stdout: "pipe", stderr: "pipe" }
        );
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return output.trim().split("\n").filter(Boolean);
    }

    private static async getChangedFiles(cwd: string, commit: string): Promise<string[]> {
        const proc = Bun.spawn(
            ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", commit],
            { cwd, stdout: "pipe", stderr: "pipe" }
        );
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return output.trim().split("\n").filter(Boolean);
    }

    private static async getFileAt(cwd: string, ref: string, file: string): Promise<string | null> {
        try {
            const proc = Bun.spawn(
                ["git", "show", `${ref}:${file}`],
                { cwd, stdout: "pipe", stderr: "pipe" }
            );
            const output = await new Response(proc.stdout).text();
            const exitCode = await proc.exited;
            if (exitCode !== 0) return null;
            return output;
        } catch {
            return null;
        }
    }

    // ─── Change Classification ───────────────────────────────────────────

    private static classifyChange(before: string, after: string): string {
        const bLines = before.split("\n");
        const aLines = after.split("\n");

        // Check if only comment lines differ
        let hasCommentDiff = false;
        let hasWhitespaceDiff = false;

        const maxLen = Math.max(bLines.length, aLines.length);
        for (let i = 0; i < maxLen; i++) {
            const bLine = (bLines[i] ?? "").trim();
            const aLine = (aLines[i] ?? "").trim();

            if (bLine === aLine) continue;

            // Check if both lines are comments or one is empty/comment
            const isCommentLine = (l: string) =>
                l.startsWith("//") || l.startsWith("/*") || l.startsWith("*") || l.startsWith("*/") || l === "";

            if (isCommentLine(bLine) && isCommentLine(aLine)) {
                hasCommentDiff = true;
            } else if (bLine === "" || aLine === "") {
                hasWhitespaceDiff = true;
            } else {
                hasWhitespaceDiff = true;
            }
        }

        if (hasCommentDiff && !hasWhitespaceDiff) return "comment-only change";
        if (hasWhitespaceDiff && !hasCommentDiff) return "whitespace/formatting change";
        return "comment/whitespace change";
    }

    // ─── Formatted Output ────────────────────────────────────────────────

    static format(result: AuditResult): string {
        const hours = (result.totalSavedSeconds / 3600).toFixed(1);
        const lines = [
            "",
            "  ▲ CORE AUDIT: RUST HISTORY",
            "  ─────────────────────────────────────────────",
            `  › Commits Scanned:    ${result.commitsScanned}`,
            `  › Files Analyzed:     ${result.filesAnalyzed}`,
            `  › Logic Changes:      ${result.logicChanges}`,
            "  ─────────────────────────────────────────────",
            `  › TAX EVENTS:         ${result.taxEvents}`,
            `  › Tax Rate:           ${result.taxRate.toFixed(1)}%`,
            `  › Time Recovered:     ${hours} hours`,
            `  › Audit Duration:     ${result.elapsedMs.toFixed(0)}ms`,
            "  ─────────────────────────────────────────────",
        ];

        if (result.events.length > 0) {
            lines.push("");
            lines.push("  Tax Event Details:");
            for (const e of result.events.slice(0, 20)) {
                lines.push(`    ${e.commit}  ${e.file}  (${e.reason})`);
            }
        }

        lines.push("");
        return lines.join("\n");
    }
}
