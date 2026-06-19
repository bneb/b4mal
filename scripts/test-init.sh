#!/bin/bash
# Test b4mal init against open-source monorepos.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
B4MAL_BIN="${1:-$SCRIPT_DIR/src/cli/index.ts}"
TMPDIR="${TMPDIR:-/tmp}/b4mal-init-test"
PASS=0
FAIL=0
COUNT=0
MAX=20

REPOS=(
  "colinhacks/zod"
  "vitest-dev/vitest"
  "changesets/changesets"
  "vercel/turborepo"
  "TanStack/query"
  "pmndrs/zustand"
  "prisma/prisma"
  "remix-run/react-router"
  "shadcn-ui/ui"
  "nestjs/nest"
  "nuxt/nuxt"
  "babel/babel"
  "eslint/eslint"
  "prettier/prettier"
  "webpack/webpack"
  "rollup/rollup"
  "vitejs/vite"
  "markedjs/marked"
  "date-fns/date-fns"
  "axios/axios"
)

mkdir -p "$TMPDIR"

for repo in "${REPOS[@]}"; do
  COUNT=$((COUNT + 1))
  [ $COUNT -gt $MAX ] && break
  name=$(echo "$repo" | tr '/' '-')
  dir="$TMPDIR/$name"
  echo "=== [$COUNT/$MAX] $repo ==="

  if [ -d "$dir/.git" ]; then
    (cd "$dir" && git pull -q --depth 1) 2>/dev/null || true
  else
    rm -rf "$dir"
    git clone -q --depth 1 "https://github.com/$repo.git" "$dir" 2>/dev/null || {
      echo "  SKIP: clone failed"
      continue
    }
  fi

  if (cd "$dir" && bun run "$B4MAL_BIN" init 2>/dev/null); then
    if [ -f "$dir/b4mal.config.json" ] || [ -f "$dir/b4mal.lock" ]; then
      echo "  PASS"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: no config produced"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL: init exited non-zero"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$dir"/b4mal.lock "$dir"/b4mal.config.json 2>/dev/null
  rm -rf "$dir/.b4mal" 2>/dev/null
done

echo ""
echo "=== $PASS pass, $FAIL fail, $COUNT tested ==="
rm -rf "$TMPDIR"
[ $FAIL -eq 0 ]
