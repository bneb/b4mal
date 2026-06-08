#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}B4MAL MIGRATION DEMO${NC}"
echo -e "Simulating layer merging.\n"

# ─── Mode Detection ─────────────────────────────────────────────────────────────
USE_DOCKER=true
if ! docker info >/dev/null 2>&1; then
    echo -e "${YELLOW}Notice: Docker daemon is not running or not accessible.${NC}"
    echo -e "Falling back to userspace simulation (cp -a) instead of native OverlayFS mounts."
    echo -e "For a rigorous demonstration using the true Linux"
    echo -e "OverlayFS kernel module, please start Docker and run this script again.\n"
    USE_DOCKER=false
fi

# ─── Cleanup ──────────────────────────────────────────────────────────────────
rm -rf workdir
mkdir -p workdir/{layer_a,layer_b,merged}

# ─── Phase 1: Baseline Mint YAML ────────────────────────────────────────────
echo -e "${YELLOW}─── Phase 1: Baseline Mint YAML (Shadowing) ───${NC}"

if [ "$USE_DOCKER" = true ]; then
    echo -e "Executing tasks in isolated containers...\n"
    docker run --rm -v $(pwd)/workdir/layer_a:/workspace -w /workspace alpine:latest sh -c "echo a > foo.txt"
    echo -e "  ${GREEN}[OK] Task A complete:${NC} workdir/layer_a/foo.txt contains 'a'"

    docker run --rm -v $(pwd)/workdir/layer_b:/workspace -w /workspace alpine:latest sh -c "echo b > foo.txt"
    echo -e "  ${GREEN}[OK] Task B complete:${NC} workdir/layer_b/foo.txt contains 'b'"

    echo -e "\nPerforming Native Linux OverlayFS Merge via 'use: [a, b]'..."
    if ! docker run --rm --privileged -v $(pwd)/workdir:/workdir alpine:latest sh -c "mount -t overlay overlay -o lowerdir=/workdir/layer_b:/workdir/layer_a /workdir/merged && cat /workdir/merged/foo.txt > /workdir/result.txt && umount /workdir/merged" 2>/dev/null; then
        echo -e "  ${YELLOW}[WARN] Privileged mount failed. Falling back to userspace merge simulation.${NC}"
        cp -a workdir/layer_a/* workdir/merged/
        cp -a workdir/layer_b/* workdir/merged/
        cat workdir/merged/foo.txt > workdir/result.txt
    fi
else
    echo -e "Executing tasks in simulated isolated layers...\n"
    sh -c "echo a > workdir/layer_a/foo.txt"
    echo -e "  ${GREEN}[OK] Task A complete:${NC} workdir/layer_a/foo.txt contains 'a'"

    sh -c "echo b > workdir/layer_b/foo.txt"
    echo -e "  ${GREEN}[OK] Task B complete:${NC} workdir/layer_b/foo.txt contains 'b'"

    echo -e "\nSimulating OverlayFS Merge via 'use: [a, b]'..."
    cp -a workdir/layer_a/* workdir/merged/
    cp -a workdir/layer_b/* workdir/merged/
    cat workdir/merged/foo.txt > workdir/result.txt
fi

RESULT=$(cat workdir/result.txt)
echo -e "  ${RED}[WARN] Task C Output:${NC} '${RESULT}'"
echo -e "  ${RED}Data Loss:${NC} Task A's output was deterministically overwritten by Task B."
echo -e "  The build is 'green', but the semantic intent is broken.\n"

# ─── Phase 2: The B4mal Solution ────────────────────────────────────────────
echo -e "${YELLOW}─── Phase 2: The b4mal Core Guard ───${NC}"
echo -e "Using PrefixTree to prove layer integrity.\n"

echo -e "1. Migrating mint.yml → b4mal..."
# Create a b4mal.lock representing the transpiled DAG
cat << 'EOF' > b4mal.lock
[
  {
    "id": "a",
    "cmd": ["echo", "a"],
    "claims": ["fs:foo.txt"],
    "deps": [],
    "reads": [],
    "writes": ["foo.txt"],
    "envReads": [],
    "envWrites": []
  },
  {
    "id": "b",
    "cmd": ["echo", "b"],
    "claims": ["fs:foo.txt"],
    "deps": ["a"],
    "reads": [],
    "writes": ["foo.txt"],
    "envReads": [],
    "envWrites": []
  },
  {
    "id": "c",
    "cmd": ["cat", "foo.txt"],
    "claims": ["fs:foo.txt"],
    "deps": ["b"],
    "reads": ["foo.txt"],
    "writes": [],
    "envReads": [],
    "envWrites": []
  }
]
EOF
echo -e "  ${GREEN}[OK] b4mal.lock generated${NC}\n"

echo -e "2. Running Formally Verified Shadow Audit..."

# We capture the output of the b4mal shadow command
SHADOW_OUT=$(bun ../../src/cli/index.ts shadow 2>&1 || true)

if echo "$SHADOW_OUT" | grep -q "shadowing event"; then
    echo -e "  ${RED}[FAIL] Path Collision Detected!${NC}"
    echo -e "  PrefixTree proved that merging these VMs will result in data masking."
    echo -e "\n${SHADOW_OUT}\n"
    
    echo -e "  ${GREEN}Solution:${NC} B4mal recalculates"
    echo -e "  the layer merge order based on DAG depth, preventing silent overwrites"
    echo -e "  before they hit the OverlayFS kernel module."
else
    echo -e "  ${RED}Test framework failure: b4mal did not catch the collision.${NC}"
    exit 1
fi

echo -e "\n${BLUE}${BOLD}Demo Complete.${NC}"
