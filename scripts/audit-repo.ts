#!/usr/bin/env bun
/**
 * Polyglot Git Audit — Comment/Whitespace Tax Scanner
 *
 * Runs b4mal's "Shadow AST" logic against any codebase.
 * For Go/Rust/non-TS files, strips comments and whitespace
 * to detect logic-invariant commits.
 */

const COMMENT_PATTERNS: Record<string, RegExp[]> = {
    ".go": [/\/\/.*$/gm, /\/\*[\s\S]*?\*\//g],
    ".rs": [/\/\/.*$/gm, /\/\*[\s\S]*?\*\//g],
    ".ts": [/\/\/.*$/gm, /\/\*[\s\S]*?\*\//g],
    ".js": [/\/\/.*$/gm, /\/\*[\s\S]*?\*\//g],
    ".py": [/#.*$/gm, /"""[\s\S]*?"""/g, /'''[\s\S]*?'''/g],
};

function stripComments(source: string, ext: string): string {
    const patterns = COMMENT_PATTERNS[ext] ?? COMMENT_PATTERNS[".go"];
    let result = source;
    for (const p of patterns) {
        result = result.replace(p, "");
    }
    return result.replace(/\s+/g, " ").trim();
}

function classifyDiff(before: string, after: string, ext: string): { isTax: boolean; reason: string } {
    if (before === after) return { isTax: false, reason: "identical" };

    const strippedBefore = stripComments(before, ext);
    const strippedAfter = stripComments(after, ext);

    if (strippedBefore === strippedAfter) {
        return { isTax: true, reason: "comment/whitespace-only" };
    }
    return { isTax: false, reason: "logic change" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const repoDir = process.argv[2] || ".";
const limit = parseInt(process.argv[3] || "100");
const extensions = [".go", ".ts", ".rs", ".js"];

console.log(`\n  ▲ b4mal AUDIT ENGINE — Scanning ${repoDir}`);
console.log(`  ─────────────────────────────────────────────────`);
console.log(`  Analyzing last ${limit} commits for Cache Miss Overhead...\n`);

// Get commits
const commitProc = Bun.spawn(
    ["git", "rev-list", "--max-count", limit.toString(), "HEAD"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
);
const commitOutput = await new Response(commitProc.stdout).text();
await commitProc.exited;
const commits = commitOutput.trim().split("\n").filter(Boolean);

let taxEvents = 0;
let logicChanges = 0;
let totalFiles = 0;
const taxDetails: Array<{ commit: string; file: string; reason: string }> = [];

for (const commit of commits) {
    // Get changed files
    const diffProc = Bun.spawn(
        ["git", "diff-tree", "--no-commit-id", "-r", "--name-only", commit],
        { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const diffOutput = await new Response(diffProc.stdout).text();
    await diffProc.exited;
    const files = diffOutput.trim().split("\n").filter(Boolean);

    for (const file of files) {
        const ext = file.slice(file.lastIndexOf("."));
        if (!extensions.includes(ext)) continue;

        totalFiles++;

        // Get before/after content
        let before: string | null = null;
        let after: string | null = null;

        try {
            const bProc = Bun.spawn(["git", "show", `${commit}^:${file}`], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
            before = await new Response(bProc.stdout).text();
            const bExit = await bProc.exited;
            if (bExit !== 0) before = null;
        } catch { before = null; }

        try {
            const aProc = Bun.spawn(["git", "show", `${commit}:${file}`], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
            after = await new Response(aProc.stdout).text();
            const aExit = await aProc.exited;
            if (aExit !== 0) after = null;
        } catch { after = null; }

        if (!before || !after) continue;

        const result = classifyDiff(before, after, ext);
        if (result.isTax) {
            taxEvents++;
            taxDetails.push({ commit: commit.slice(0, 7), file, reason: result.reason });
        } else if (result.reason !== "identical") {
            logicChanges++;
        }
    }
}

// ── Report ────────────────────────────────────────────────────────────────────

const taxRate = totalFiles > 0 ? ((taxEvents / totalFiles) * 100).toFixed(1) : "0.0";
const avgTaskSec = 300; // CI default
const recoveredSec = taxEvents * avgTaskSec;
const recoveredHours = (recoveredSec / 3600).toFixed(1);

console.log(`  › Commits Scanned:       ${commits.length}`);
console.log(`  › Files Analyzed:        ${totalFiles}`);
console.log(`  › Logic Changes:         ${logicChanges}`);
console.log(`  ──────────────────────────────────────`);
console.log(`  › TAX EVENTS DETECTED:   \x1b[91m\x1b[1m${taxEvents}\x1b[0m`);
console.log(`  › Cache Miss Overhead Rate:  \x1b[93m${taxRate}%\x1b[0m`);
console.log(`  › Projected Recovery:    \x1b[92m\x1b[1m${recoveredHours} hours\x1b[0m \x1b[2m(at ${avgTaskSec}s avg task)\x1b[0m`);
console.log(`  ──────────────────────────────────────\n`);

if (taxDetails.length > 0) {
    console.log(`  Tax Event Details (top ${Math.min(20, taxDetails.length)}):`);
    for (const d of taxDetails.slice(0, 20)) {
        console.log(`    \x1b[91m${d.commit}\x1b[0m  ${d.file}  \x1b[2m(${d.reason})\x1b[0m`);
    }
    console.log("");
}
