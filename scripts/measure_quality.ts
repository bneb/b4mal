// Measure LOC and nesting for all new/modified source files
const fs = require("fs");
const files = [
  "src/config_loader.ts",
  "src/remote/s3_adapter.ts", 
  "src/core/remote_vault.ts",
  "src/shim/ci_emitter.ts",
  "src/cli/ci.ts",
  "src/cli/watch.ts",
  "src/lsp/server.ts",
];

interface FnInfo {
  name: string;
  start: number;
  end: number;
  loc: number;
  params: number;
  maxNesting: number;
}

function measureFile(filepath: string): FnInfo[] {
  if (!fs.existsSync(filepath)) return [];
  const lines = fs.readFileSync(filepath, "utf-8").split("\n");
  const fns: FnInfo[] = [];
  
  // Find function boundaries
  const fnStarts: {name: string; line: number; indent: number}[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match function/method declarations
    const m = line.match(/^(\s*)(?:export\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*\([^)]*\)\s*[:{])/);
    if (m) {
      const name = m[2] || m[3];
      const indent = (m[1] || "").length;
      if (name && !["if", "for", "while", "switch", "catch", "try"].includes(name)) {
        fnStarts.push({name, line: i, indent});
      }
    }
  }
  
  // Find matching closing braces by tracking brace depth
  for (const fn of fnStarts) {
    let depth = 0;
    let started = false;
    let maxDepth = 0;
    let endLine = fn.line;
    
    for (let i = fn.line; i < lines.length; i++) {
      const stripped = lines[i].trim();
      // Count braces on this line
      for (const ch of stripped) {
        if (ch === "{") { depth++; started = true; }
        if (ch === "}") { depth--; }
      }
      if (started) {
        maxDepth = Math.max(maxDepth, depth);
      }
      if (started && depth === 0) {
        endLine = i;
        break;
      }
    }
    
    const loc = endLine - fn.line + 1;
    const nesting = maxDepth;
    
    // Count params
    const sigLine = lines[fn.line];
    const paramMatch = sigLine.match(/\(([^)]*)\)/);
    const params = paramMatch ? paramMatch[1].split(",").filter(p => p.trim()).length : 0;
    
    fns.push({
      name: fn.name,
      start: fn.line + 1,
      end: endLine + 1,
      loc,
      params,
      maxNesting: nesting,
    });
  }
  
  return fns;
}

let totalViolations = 0;
for (const file of files) {
  const fns = measureFile(file);
  if (fns.length === 0) continue;
  
  const violations = fns.filter(f => f.loc > 32 || f.maxNesting > 3 || f.params > 4);
  
  console.log(`\n${file} (${fns.length} functions):`);
  for (const f of fns) {
    const flags: string[] = [];
    if (f.loc > 32) flags.push(`LOC:${f.loc}`);
    if (f.maxNesting > 3) flags.push(`NEST:${f.maxNesting}`);
    if (f.params > 4) flags.push(`PARAMS:${f.params}`);
    const status = flags.length > 0 ? ` ⚠️  ${flags.join(" ")}` : " ✓";
    console.log(`  ${f.name}() — ${f.loc} LOC, nest ${f.maxNesting}, ${f.params} params${status}`);
    if (flags.length > 0) totalViolations++;
  }
  
  if (violations.length === 0) {
    console.log(`  ✅ All functions pass quality gates`);
  }
}

console.log(`\n=== TOTAL VIOLATIONS: ${totalViolations} ===`);
if (totalViolations === 0) {
  console.log("✅ ALL QUALITY GATES MET: <32 LOC, <3 nesting, <5 params");
}
