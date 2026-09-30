#!/usr/bin/env bash
# Comparative benchmark: b4mal vs Turborepo vs Nx.
#
# Reproduces the numbers in the "Comparisons" section of README.md. Two parts:
#   A. wall-clock (cold and warm cache)
#   B. correctness — do two tasks writing the same file corrupt each other?
#
# Prerequisites: node, bun, aws not required; `npm install turbo nx` in the
# fixture. Everything runs locally with no remote cache on any side.
#
# Read the caveats in README.md before quoting any number from this.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${B4MAL_BENCH_DIR:-$(mktemp -d)}"
CLI="$HERE/../src/cli/index.ts"
PACKAGES=8
BUILD_ITERS="${B4MAL_BENCH_BUILD_ITERS:-3001}"   # ~0.75s per task
TEST_ITERS="${B4MAL_BENCH_TEST_ITERS:-1501}"    # ~0.45s per task
REPS=3

mkdir -p "$WORK/monorepo" && cd "$WORK/monorepo"

# ── fixture ─────────────────────────────────────────────────────────────────
# Tasks do non-elidable work (SHA-256 over 256KB) seeded per package, so every
# package writes distinct, verifiable output. Package identity is passed
# explicitly: turbo/nx run with cwd=package while b4mal runs from the repo root,
# so inferring it from the output path silently collapses all packages together.
cat > "$WORK/task.js" <<'EOF'
import { createHash } from "crypto"; import fs from "fs"; import path from "path";
const [,, outFile, iters, pkg] = process.argv;
const seed = createHash("sha256").update(pkg).digest();
const buf = Buffer.alloc(256 * 1024);
for (let i = 0; i < buf.length; i++) buf[i] = seed[i % 32];
let acc = 0;
for (let i = 0; i < parseInt(iters); i++) acc ^= createHash("sha256").update(buf).digest()[0];
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `out:${pkg}:${acc}\n`);
EOF

T="$WORK/task.js"
for i in $(seq 1 $PACKAGES); do mkdir -p "pkg$i/src"; echo "export const v$i=$i;" > "pkg$i/src/index.js"; done
printf '{"name":"b4mal-bench","private":true,"workspaces":["pkg*"],"packageManager":"bun@1.3.14"}\n' > package.json

bun -e '
const T = process.argv[1], N = +process.argv[2], B = process.argv[3], S = process.argv[4];
for (let i=1;i<=N;i++){
  const p = await Bun.file(`pkg${i}/package.json`).json();
  p.name = `pkg${i}`; p.version="1.0.0"; p.private=true;
  p.scripts = { build: `bun ${T} dist/out.js ${B} pkg${i}`, test: `bun ${T} dist/test.txt ${S} pkg${i}` };
  await Bun.write(`pkg${i}/package.json`, JSON.stringify(p,null,2));
}
const tasks = {};
for (let i=1;i<=N;i++){
  tasks[`build-pkg${i}`] = { cmd:["bun",T,`pkg${i}/dist/out.js`,B,`pkg${i}`], inputs:[`pkg${i}/src`], outputs:[`pkg${i}/dist/out.js`] };
  tasks[`test-pkg${i}`]  = { cmd:["bun",T,`pkg${i}/dist/test.txt`,S,`pkg${i}`], inputs:[`pkg${i}/src`], outputs:[`pkg${i}/dist/test.txt`] };
}
await Bun.write("b4mal.config.json", JSON.stringify({tasks},null,2));
' "$T" "$PACKAGES" "$BUILD_ITERS" "$TEST_ITERS"

printf '{ "$schema":"https://turbo.build/schema.json","tasks":{ "build":{"outputs":["dist/**"]}, "test":{"outputs":["dist/**"]} } }\n' > turbo.json
printf '{ "targetDefaults":{ "build":{"outputs":["{projectRoot}/dist/**"],"cache":true}, "test":{"outputs":["{projectRoot}/dist/**"],"cache":true} } }\n' > nx.json

if [ ! -x node_modules/.bin/turbo ] || [ ! -x node_modules/.bin/nx ]; then
  echo "Installing turbo + nx (once)..."; npm install --no-audit --no-fund turbo@latest nx@latest >/dev/null 2>&1
fi

export B4MAL_DB_PATH="$WORK/.b4mal/cache.db"
wipe() { rm -rf .b4mal "$HOME"/.b4mal/artifacts node_modules/.cache/turbo node_modules/.nx .turbo pkg*/dist 2>/dev/null; }
run_tool() {
  case "$1" in
    b4mal) bun "$CLI" build >/dev/null 2>&1 ;;
    turbo) ./node_modules/.bin/turbo run build test >/dev/null 2>&1 ;;
    nx)    ./node_modules/.bin/nx run-many -t build -t test --all >/dev/null 2>&1 ;;
  esac
}
# A run that reports success without doing the work must never be timed.
outputs_ok() {
  local n d
  n=$(ls pkg*/dist/out.js 2>/dev/null | wc -l | tr -d ' ')
  d=$(cat pkg*/dist/out.js 2>/dev/null | sort -u | wc -l | tr -d ' ')
  [ "$n" -eq "$PACKAGES" ] && [ "$d" -eq "$PACKAGES" ]
}
median() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2}'; }

echo
echo "=== A. wall-clock (median of $REPS; local cache only, no remote cache) ==="
printf '%-7s %-6s %-24s %s\n' TOOL MODE "RUNS (s)" MEDIAN
printf '%s\n' "------------------------------------------------"
for tool in b4mal turbo nx; do
  for mode in cold warm; do
    times=()
    for r in $(seq 1 $REPS); do
      [ "$mode" = cold ] && wipe
      s=$(python3 -c 'import time;print(time.time())'); run_tool "$tool"
      e=$(python3 -c 'import time;print(time.time())')
      outputs_ok && times+=("$(awk -v a="$s" -v b="$e" 'BEGIN{printf "%.3f", b-a}')") || times+=("INVALID")
    done
    if printf '%s\n' "${times[@]}" | grep -q INVALID; then
      printf '%-7s %-6s %-24s %s\n' "$tool" "$mode" "$(IFS=,; echo "${times[*]}")" "ABORTED"
    else
      printf '%-7s %-6s %-24s %ss\n' "$tool" "$mode" "$(IFS=,; echo "${times[*]}")" "$(median "${times[@]}")"
    fi
  done
done

echo
echo "=== B. correctness: two tasks writing the SAME file ==="
# Each writer truncates the file, pauses, then finishes. Run concurrently the
# file tears (one writer's head, the other's tail); serialised it stays whole.
mkdir -p "$WORK/race" && cd "$WORK/race"
printf '{"name":"race","private":true,"workspaces":["pkgA","pkgB"],"packageManager":"bun@1.3.14"}\n' > package.json
OUT="$WORK/race/out.txt"
for t in A B; do
  mkdir -p "pkg$t"; echo "export const x=1;" > "pkg$t/i.js"
  printf '{"name":"pkg%s","version":"1.0.0","scripts":{"writer-%s":"bun -e %s"}}' "$t" "$t" \
    "\"import fs from 'fs'; fs.writeFileSync('$OUT','$t-HEAD\\\\n'); await new Promise(r=>setTimeout(r,400)); fs.appendFileSync('$OUT','$t-TAIL\\\\n');\"" \
    > "pkg$t/package.json"
done
printf '{"name":"race","private":true,"workspaces":["pkgA","pkgB"],"packageManager":"bun@1.3.14"}\n' > package.json
cp -r "$WORK/monorepo/node_modules" . 2>/dev/null
printf '{ "$schema":"https://turbo.build/schema.json","tasks":{ "writer-a":{}, "writer-b":{} } }\n' > turbo.json
printf '{ "targetDefaults":{ "writer-a":{}, "writer-b":{} } }\n' > nx.json
bun -e '
const out = process.argv[1];
const w = (tag) => ["bun","-e",`import fs from "fs"; fs.writeFileSync("${out}","${tag}-HEAD\\n"); await new Promise(r=>setTimeout(r,400)); fs.appendFileSync("${out}","${tag}-TAIL\\n");`];
await Bun.write("b4mal.config.json", JSON.stringify({tasks:{
  "writer-a":{cmd:w("A"), outputs:["out.txt"]},
  "writer-b":{cmd:w("B"), outputs:["out.txt"]}}},null,2));
' "$OUT"
ROUNDS=5
echo "5 rounds. CONSISTENT = both halves from one writer (2 lines). TORN = interleaved."
for tool in b4mal turbo nx; do
  c=0; tr=0
  for r in $(seq 1 $ROUNDS); do
    rm -f out.txt; rm -rf .b4mal "$HOME"/.b4mal/artifacts node_modules/.cache/turbo node_modules/.nx .turbo 2>/dev/null
    case "$tool" in
      b4mal) bun "$CLI" build >/dev/null 2>&1 ;;
      turbo) ./node_modules/.bin/turbo run writer-a writer-b >/dev/null 2>&1 ;;
      nx)    ./node_modules/.bin/nx run-many -t writer-a -t writer-b --all --skip-nx-cache >/dev/null 2>&1 ;;
    esac
    if [ ! -f out.txt ]; then continue; fi
    # A whole file has exactly 2 lines whose head and tail share one writer.
    n=$(wc -l < out.txt | tr -d ' ')
    h=$(head -1 out.txt); t=$(tail -1 out.txt)
    if [ "$n" = "2" ] && { [ "$h" = "A-HEAD" ] && [ "$t" = "A-TAIL" ]; } || { [ "$h" = "B-HEAD" ] && [ "$t" = "B-TAIL" ]; }; then
      c=$((c+1)); else tr=$((tr+1)); fi
  done
  printf '  %-6s %d consistent / %d torn of %d\n' "$tool" "$c" "$tr" "$ROUNDS"
done