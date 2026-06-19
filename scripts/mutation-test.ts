#!/usr/bin/env bun
/**
 * Mutation testing: verifies that test suite catches intentional bugs.
 * For each source file, generates mutants by inverting conditionals, swapping
 * operators, and deleting statements. Runs relevant tests against each mutant.
 * Reports any surviving mutants (tests didn't catch the change).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

interface Mutant {
  file: string;
  line: number;
  original: string;
  mutated: string;
  description: string;
}

const TARGETS = [
  { src: "src/config_loader.ts", test: "tests/config_loader.test.ts" },
  { src: "src/core/remote_vault.ts", test: "tests/remote_vault.test.ts" },
  { src: "src/remote/s3_adapter.ts", test: "tests/remote_s3_adapter.test.ts" },
  { src: "src/orchestrator/executor.ts", test: "tests/" },
];

function generateMutants(filepath: string): Mutant[] {
  const content = fs.readFileSync(filepath, "utf-8");
  const lines = content.split("\n");
  const mutants: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**") || !trimmed) continue;

    // Mutant 1: Invert boolean conditionals
    const condMatch = trimmed.match(/^(\s*)(if|while)\s*\((.+)\)\s*\{?/);
    if (condMatch) {
      const indent = condMatch[1];
      const keyword = condMatch[2];
      const condition = condMatch[3];
      mutants.push({
        file: filepath, line: i + 1, original: line,
        mutated: `${indent}${keyword} (!(${condition})) {`,
        description: `Invert ${keyword} condition at line ${i + 1}`,
      });
    }

    // Mutant 2: Swap comparison operators
    for (const [op, swapped] of [["===", "!=="], ["!==", "==="], [">", "<="], ["<", ">="], ["&&", "||"], ["||", "&&"]] as [string, string][]) {
      if (trimmed.includes(` ${op} `) && !trimmed.startsWith("import")) {
        mutants.push({
          file: filepath, line: i + 1, original: line,
          mutated: line.replace(` ${op} `, ` ${swapped} `),
          description: `Swap ${op} → ${swapped} at line ${i + 1}`,
        });
        break; // One operator swap per line
      }
    }

    // Mutant 3: Delete return statements
    if (trimmed.match(/^\s*return\s/)) {
      mutants.push({
        file: filepath, line: i + 1, original: line,
        mutated: `${line.match(/^(\s*)/)![0]}// [MUTANT] return deleted`,
        description: `Delete return at line ${i + 1}`,
      });
    }
  }

  return mutants.slice(0, 50); // Cap at 50 mutants per file
}

function applyMutant(mutant: Mutant): void {
  const content = fs.readFileSync(mutant.file, "utf-8");
  const lines = content.split("\n");
  lines[mutant.line - 1] = mutant.mutated;
  fs.writeFileSync(mutant.file, lines.join("\n"), "utf-8");
}

function restoreOriginal(filepath: string): void {
  execSync(`git checkout -- ${filepath}`, { stdio: "ignore" });
}

function runTests(testPath: string): boolean {
  try {
    execSync(`bun test ${testPath} 2>&1`, { stdio: "pipe", timeout: 30000 });
    return true; // Tests passed — mutant SURVIVED
  } catch {
    return false; // Tests failed — mutant KILLED
  }
}

let totalMutants = 0;
let killedMutants = 0;
let survivedMutants: Mutant[] = [];

for (const target of TARGETS) {
  if (!fs.existsSync(target.src)) continue;
  const mutants = generateMutants(target.src);
  totalMutants += mutants.length;

  process.stdout.write(`\n${target.src}: ${mutants.length} mutants\n`);

  for (const mutant of mutants) {
    try {
      applyMutant(mutant);
      const survived = runTests(target.test);
      if (survived) {
        survivedMutants.push(mutant);
        process.stdout.write(`  SURVIVED: ${mutant.description}\n`);
      } else {
        killedMutants++;
      }
    } finally {
      restoreOriginal(target.src);
    }
  }
}

// Restore all files
for (const target of TARGETS) restoreOriginal(target.src);

const pct = totalMutants > 0 ? Math.round((killedMutants / totalMutants) * 100) : 0;
process.stdout.write(`\n=== Mutation Score: ${killedMutants}/${totalMutants} killed (${pct}%) ===\n`);

if (survivedMutants.length > 0) {
  process.stdout.write(`\n${survivedMutants.length} surviving mutants:\n`);
  for (const m of survivedMutants) {
    process.stdout.write(`  ${m.file}:${m.line} — ${m.description}\n`);
  }
  process.exit(1);
} else {
  process.stdout.write("Zero surviving mutants.\n");
  process.exit(0);
}
