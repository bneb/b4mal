#!/usr/bin/env node
/**
 * Turn a `b4mal check --json` report into GitHub Actions annotations and step
 * outputs.
 *
 * Lives in the repo (rather than inline in action.yml) so the mapping from
 * findings to workflow commands is unit-testable — the escaping rules for
 * workflow commands are fiddly and silently break when wrong, and a malformed
 * annotation is worse than none.
 *
 * Usage: node scripts/b4mal-report.mjs <report.json> [--file <path>] [--title <text>]
 *
 * Writes to $GITHUB_OUTPUT when set (counts + verified) and prints annotations to
 * stdout. Exits 0 regardless of findings: the action decides the exit status,
 * because "report" and "gate" are separate concerns.
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const reportPath = args[0];
const fileIdx = args.indexOf("--file");
const titleIdx = args.indexOf("--title");
const targetFile = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
const title = titleIdx !== -1 ? args[titleIdx + 1] : undefined;

/**
 * Escape for a workflow command message. %, CR and LF are command-breaking.
 */
function escMessage(s) {
    return String(s)
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A");
}

/** Escape for a workflow-command *property* value, where , and : are structural. */
function escProperty(s) {
    return escMessage(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function annotation(level, message, file) {
    let line = `::${level}`;
    if (file) line += ` file=${escProperty(file)}`;
    line += `::${escMessage(message)}`;
    return line;
}

function setOutput(name, value) {
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    }
}

if (!reportPath || !existsSync(reportPath)) {
    console.log("::notice::b4mal check produced no report (nothing to audit).");
    setOutput("verified", "true");
    setOutput("findings", "0");
    setOutput("collisions", "0");
    setOutput("shadows", "0");
    setOutput("implicit", "0");
    process.exit(0);
}

let report;
try {
    report = JSON.parse(readFileSync(reportPath, "utf-8"));
} catch {
    console.log("::error::b4mal check output was not valid JSON — see the step log.");
    setOutput("verified", "false");
    setOutput("findings", "1");
    setOutput("collisions", "0");
    setOutput("shadows", "0");
    setOutput("implicit", "0");
    process.exit(0);
}

const findings = Array.isArray(report.findings) ? report.findings : [];
const collisions = report.collisions ?? findings.filter(f => f.type === "collision").length;
const shadows = report.shadows ?? findings.filter(f => f.type === "shadow").length;
const implicit = findings.filter(f => f.type === "implicit-dependency").length;
const total = findings.length || (collisions + shadows + implicit);

// A collision is a hard conflict the scheduler would have to serialize silently;
// a shadow or implicit dependency is a real but non-fatal ordering hazard.
for (const f of findings) {
    const level = f.type === "collision" ? "error" : "warning";
    console.log(annotation(level, f.message ?? "resource conflict", targetFile));
}

if (report.note) console.log(`::notice::${report.note}`);
if (title) console.log(`::notice::${title}`);

setOutput("verified", String(report.verified ?? (total === 0)));
setOutput("findings", String(total));
setOutput("collisions", String(collisions));
setOutput("shadows", String(shadows));
setOutput("implicit", String(implicit));
