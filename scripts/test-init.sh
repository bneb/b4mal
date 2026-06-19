#!/bin/bash
# Test b4mal init against open-source monorepos.
# Usage: ./scripts/test-init.sh [b4mal-binary-path]
# Defaults to 'bun run src/cli/index.ts' if no binary specified.

set -e
B4MAL="${1:-bun run src/cli/index.ts}"
TMPDIR="${TMPDIR:-/tmp}/b4mal-init-test"
PASS=0
FAIL=0

# Repos to test against (well-known monorepos with package.json)
REPOS=(
  "https://github.com/colinhacks/zod"            # TypeScript library
  "https://github.com/vitest-dev/vitest"         # Monorepo test framework
  "https://github.com/changesets/changesets"     # Monorepo tool
  "https://github.com/vercel/turborepo"          # Monorepo examples
)

mkdir -p "$TMPDIR"

for repo in "${REPOS[@]}"; do
  name=$(basename "$repo")
  dir="$TMPDIR/$name"

  echo "=== Testing $name ==="

  if [ -d "$dir" ]; then
    (cd "$dir" && git pull -q) || true
  else
    git clone -q --depth 1 "$repo" "$dir" 2>/dev/null || {
      echo "  SKIP: clone failed"
      continue
    }
  fi

  cd "$dir"

  # Run init
  if $B4MAL init 2>&1 | tee /tmp/b4mal-init-$name.log; then
    # Check that b4mal.lock or b4mal.config.json was created
    if [ -f b4mal.config.json ] || [ -f b4mal.lock ]; then
      echo "  PASS: init produced config"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: init ran but no config produced"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL: init exited non-zero"
    FAIL=$((FAIL + 1))
  fi

  # Clean up generated files
  rm -f b4mal.lock b4mal.config.json
  cd "$OLDPWD"
done

echo ""
echo "=== Results: $PASS pass, $FAIL fail ==="
rm -rf "$TMPDIR"
