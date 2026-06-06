#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# B4mal Polyglot "Resource War" Orchestration
#
# Simulates a scenario where Rust, Python, and TypeScript services
# all attempt to claim overlapping resources simultaneously,
# demonstrating the Resource Monitor Z3 collision detection in action.
#
# Usage:
#   cd examples/polyglot-war
#   ./run_war.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${DIR}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  IGNITING THE POLYGLOT RESOURCE WAR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ensure b4mal is in PATH (we use the local one for this test)
export PATH="${DIR}/../../bin:${HOME}/.local/bin:${PATH}"

if ! command -v b4mal >/dev/null 2>&1; then
    echo "[WARN] b4mal binary not found in PATH."
    echo "Please run 'bun run build' and install it first."
    exit 1
fi

echo "  B4mal Engine Version:"
b4mal --version

echo ""
echo "  [1/3] Compiling the Rust BinaryCompiler..."
# We just simulate it with a script that calls the b4mal binary directly
# to avoid requiring the user to have cargo installed just to run the example.
b4mal attest "BinaryCompiler" "fs:write:dist/app.bin" "env:LICENSE_KEY" &
RUST_PID=$!

echo "  [2/3] Starting the Python DataProcessor..."
python3 processor.py &
PY_PID=$!

echo "  [3/3] Starting the TypeScript WebIntegrator..."
if command -v bun >/dev/null 2>&1; then
    bun run server.ts &
else
    npx ts-node server.ts &
fi
TS_PID=$!

echo ""
echo "  WAR IS ACTIVE. Waiting for processes..."
wait $RUST_PID
wait $PY_PID
wait $TS_PID

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESOURCE WAR CONCLUDED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Check the b4mal HUD for the Path-based Isolation results."
echo "  You should see:"
echo "    - [SAFE]   BinaryCompiler (env:LICENSE_KEY)"
echo "    - [WARN] [SAT]    BinaryCompiler vs DataProcessor (dist/app.bin)"
echo "    - [WARN] [SAT]    DataProcessor vs WebIntegrator (db/local.sqlite)"
echo ""
