/**
 * Benchmark b4mal init against real open-source monorepos.
 *
 * For each repo: clone → b4mal init → categorize as GREEN/YELLOW/RED.
 *
 * GREEN:  lockfile has functional commands (not echo placeholders)
 * YELLOW: lockfile produced but commands are echo placeholders or missing
 * RED:    init crashed, produced nothing, or lockfile absent
 *
 * Usage: bun run scripts/benchmark-init.ts [--keep] [--max N] [--filter pattern]
 */

import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Repo catalog ──────────────────────────────────────────────────────────

const REPOS: { org: string; name: string; tags: string[] }[] = [
  // TypeScript monorepos (npm/pnpm workspaces)
  { org: "colinhacks", name: "zod", tags: ["ts", "pnpm"] },
  { org: "vitest-dev", name: "vitest", tags: ["ts", "pnpm"] },
  { org: "changesets", name: "changesets", tags: ["ts", "pnpm"] },
  { org: "TanStack", name: "query", tags: ["ts", "pnpm"] },
  { org: "pmndrs", name: "zustand", tags: ["ts", "pnpm"] },
  { org: "remix-run", name: "react-router", tags: ["ts", "pnpm"] },
  { org: "shadcn-ui", name: "ui", tags: ["ts", "pnpm"] },
  { org: "date-fns", name: "date-fns", tags: ["ts", "pnpm"] },
  { org: "markedjs", name: "marked", tags: ["ts", "pnpm"] },

  // Large JS/TS monorepos
  { org: "nestjs", name: "nest", tags: ["ts", "large"] },
  { org: "babel", name: "babel", tags: ["js", "large"] },
  { org: "eslint", name: "eslint", tags: ["js", "large"] },
  { org: "prettier", name: "prettier", tags: ["js", "large"] },
  { org: "webpack", name: "webpack", tags: ["js", "large"] },
  { org: "rollup", name: "rollup", tags: ["js", "large"] },
  { org: "vitejs", name: "vite", tags: ["ts", "large"] },
  { org: "axios", name: "axios", tags: ["js"] },

  // Build tools (dogfood potential)
  { org: "evanw", name: "esbuild", tags: ["ts", "go"] },
  { org: "privatenumber", name: "tsx", tags: ["ts"] },

  // Rust workspaces
  { org: "BurntSushi", name: "ripgrep", tags: ["rust"] },
  { org: "sharkdp", name: "bat", tags: ["rust"] },
  { org: "astral-sh", name: "ruff", tags: ["rust", "large"] },
  { org: "casey", name: "just", tags: ["rust"] },
  { org: "sharkdp", name: "fd", tags: ["rust"] },

  // Go monorepos
  { org: "golang", name: "tools", tags: ["go"] },
  { org: "gohugoio", name: "hugo", tags: ["go"] },
  { org: "cli", name: "cli", tags: ["go"] },  // GitHub CLI

  // Python
  { org: "pypa", name: "pip", tags: ["python"] },
  { org: "python-poetry", name: "poetry", tags: ["python"] },
  { org: "psf", name: "black", tags: ["python"] },

  // Mixed/polyglot
  { org: "prisma", name: "prisma", tags: ["ts", "rust", "mixed"] },
  { org: "nuxt", name: "nuxt", tags: ["ts", "pnpm"] },
  { org: "tauri-apps", name: "tauri", tags: ["rust", "ts", "mixed"] },

  // Turborepo/Nx users
  { org: "vercel", name: "turbo", tags: ["ts", "turborepo", "large"] },
  { org: "nrwl", name: "nx", tags: ["ts", "nx"] },
];

// ─── Types ─────────────────────────────────────────────────────────────────

interface RepoResult {
  repo: string;
  tags: string[];
  status: "GREEN" | "YELLOW" | "RED";
  taskCount: number;
  placeholderCount: number;
  functionalCount: number;
  packageScriptsDetected: string[];
  error?: string;
  initDurationMs: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function cloneRepo(org: string, name: string, dir: string): boolean {
  const url = `https://github.com/${org}/${name}.git`;
  try {
    const proc = Bun.spawnSync(["git", "clone", "--depth", "1", url, dir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function runInit(dir: string, scriptPath: string): { success: boolean; durationMs: number; error?: string } {
  const start = performance.now();
  try {
    const proc = Bun.spawnSync(["bun", "run", scriptPath, "init"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });
    const durationMs = performance.now() - start;
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr);
      return { success: false, durationMs, error: stderr.slice(0, 500) };
    }
    return { success: true, durationMs };
  } catch (e: any) {
    return { success: false, durationMs: performance.now() - start, error: e.message };
  }
}

function analyzeLockfile(lockPath: string): {
  taskCount: number;
  placeholderCount: number;
  functionalCount: number;
  packageScriptsDetected: string[];
} {
  if (!existsSync(lockPath)) {
    return { taskCount: 0, placeholderCount: 0, functionalCount: 0, packageScriptsDetected: [] };
  }

  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
    const tasks = Array.isArray(raw) ? raw : (raw.tasks ?? []);
    let placeholderCount = 0;
    let functionalCount = 0;
    const scripts: string[] = [];

    for (const t of tasks) {
      const cmd = t.cmd ?? [];
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("echo") && (cmdStr.includes("No package.json script") || cmdStr.includes("placeholder"))) {
        placeholderCount++;
      } else if (cmd.length > 0 && cmd[0] !== "echo") {
        functionalCount++;
        if (cmdStr.includes("bun run") || cmdStr.includes("npm run") || cmdStr.includes("pnpm") || cmdStr.includes("yarn")) {
          scripts.push(t.id);
        }
      }
    }

    return { taskCount: tasks.length, placeholderCount, functionalCount, packageScriptsDetected: scripts };
  } catch {
    return { taskCount: 0, placeholderCount: 0, functionalCount: 0, packageScriptsDetected: [] };
  }
}

function categorizeResult(analysis: ReturnType<typeof analyzeLockfile>, initSuccess: boolean): "GREEN" | "YELLOW" | "RED" {
  if (!initSuccess) return "RED";
  if (analysis.taskCount === 0) return "RED";
  if (analysis.functionalCount === analysis.taskCount && analysis.placeholderCount === 0) return "GREEN";
  if (analysis.functionalCount > 0) return "YELLOW"; // Partial success
  return "YELLOW"; // All placeholders
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = Bun.argv.slice(2);
  const keep = args.includes("--keep");
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1]?.toLowerCase() : undefined;
  const maxIdx = args.indexOf("--max");
  const maxRepos = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : REPOS.length;

  const scriptPath = join(import.meta.dir, "..", "src", "cli", "index.ts");
  const workDir = keep
    ? join(tmpdir(), "b4mal-benchmark")
    : mkdtempSync(join(tmpdir(), "b4mal-bench-"));

  if (!keep) {
    mkdirSync(workDir, { recursive: true });
  }

  const results: RepoResult[] = [];
  let tested = 0;

  for (const repo of REPOS) {
    if (tested >= maxRepos) break;
    const repoName = `${repo.org}/${repo.name}`;
    if (filter && !repoName.toLowerCase().includes(filter) && !repo.tags.some(t => t.includes(filter))) {
      continue;
    }

    tested++;
    const dir = join(workDir, `${repo.org}-${repo.name}`);
    console.log(`\n[${tested}/${Math.min(maxRepos, REPOS.length)}] ${repoName} [${repo.tags.join(", ")}]`);

    // Clone
    if (!existsSync(join(dir, ".git"))) {
      const cloned = cloneRepo(repo.org, repo.name, dir);
      if (!cloned) {
        console.log(`  SKIP: clone failed`);
        results.push({
          repo: repoName, tags: repo.tags, status: "RED", taskCount: 0,
          placeholderCount: 0, functionalCount: 0, packageScriptsDetected: [],
          error: "Clone failed", initDurationMs: 0,
        });
        continue;
      }
    } else {
      console.log(`  (using existing clone)`);
    }

    // Run init
    const initResult = runInit(dir, scriptPath);
    console.log(`  Init: ${initResult.success ? "OK" : "FAIL"} (${initResult.durationMs.toFixed(0)}ms)`);
    if (initResult.error) {
      console.log(`  Error: ${initResult.error.slice(0, 200)}`);
    }

    // Analyze lockfile
    const lockPath = join(dir, "b4mal.lock");
    const analysis = analyzeLockfile(lockPath);
    const status = categorizeResult(analysis, initResult.success);

    const result: RepoResult = {
      repo: repoName, tags: repo.tags, status,
      taskCount: analysis.taskCount,
      placeholderCount: analysis.placeholderCount,
      functionalCount: analysis.functionalCount,
      packageScriptsDetected: analysis.packageScriptsDetected,
      error: initResult.error,
      initDurationMs: initResult.durationMs,
    };
    results.push(result);

    const statusIcon = status === "GREEN" ? "✓" : status === "YELLOW" ? "⚠" : "✗";
    console.log(`  Result: ${statusIcon} ${status} | ${analysis.taskCount} tasks, ${analysis.functionalCount} functional, ${analysis.placeholderCount} placeholders`);

    // Cleanup lockfile for fresh test
    try { rmSync(lockPath, { force: true }); } catch {}
    try { rmSync(join(dir, ".b4mal"), { recursive: true, force: true }); } catch {}
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  const green = results.filter(r => r.status === "GREEN");
  const yellow = results.filter(r => r.status === "YELLOW");
  const red = results.filter(r => r.status === "RED");
  const totalTasks = results.reduce((sum, r) => sum + r.taskCount, 0);
  const totalFunctional = results.reduce((sum, r) => sum + r.functionalCount, 0);
  const totalPlaceholders = results.reduce((sum, r) => sum + r.placeholderCount, 0);

  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(60));
  console.log(`Total repos tested:       ${results.length}`);
  console.log(`GREEN  (functional):      ${green.length} (${((green.length/results.length)*100).toFixed(0)}%)`);
  console.log(`YELLOW (partial/wrong):   ${yellow.length} (${((yellow.length/results.length)*100).toFixed(0)}%)`);
  console.log(`RED    (failed):          ${red.length} (${((red.length/results.length)*100).toFixed(0)}%)`);
  console.log(`Total tasks generated:    ${totalTasks}`);
  console.log(`Functional commands:      ${totalFunctional} (${totalTasks > 0 ? ((totalFunctional/totalTasks)*100).toFixed(0) : 0}%)`);
  console.log(`Placeholder commands:     ${totalPlaceholders}`);

  if (yellow.length > 0) {
    console.log("\n⚠ YELLOW repos (need improvement):");
    for (const r of yellow) {
      console.log(`  ${r.repo} — ${r.functionalCount}/${r.taskCount} functional, ${r.placeholderCount} placeholders`);
    }
  }

  if (red.length > 0) {
    console.log("\n✗ RED repos (failed):");
    for (const r of red) {
      console.log(`  ${r.repo} — ${r.error?.slice(0, 100) || "unknown"}`);
    }
  }

  if (green.length > 0) {
    console.log("\n✓ GREEN repos:");
    for (const r of green) {
      console.log(`  ${r.repo} — ${r.taskCount} tasks, all functional`);
    }
  }

  // Write JSON report
  const reportPath = join(workDir, "benchmark-report.json");
  writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\nFull report: ${reportPath}`);

  if (!keep) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  process.exit(yellow.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
