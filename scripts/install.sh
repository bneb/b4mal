#!/usr/bin/env bash
set -euo pipefail
# scripts/install.sh — b4mal installer
#
# Compiles the b4mal CLI into a standalone binary using Bun's
# native --compile flag and installs it to ~/.local/bin/.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB/b4mal/main/scripts/install.sh | bash
#   bash scripts/install.sh   # local install from repo root

# ─── Colours ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { echo -e "${CYAN}${BOLD}  →${RESET}  $*"; }
ok()      { echo -e "${GREEN}  [OK] ${RESET}  $*"; }
warn()    { echo -e "${YELLOW}  [WARN] ${RESET}  $*"; }
fatal()   { echo -e "${RED}  ✗${RESET}  $*" >&2; exit 1; }

# ─── Header ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}b4mal${RESET}"
echo -e "${DIM}  https://github.com/bneb/b4mal${RESET}"
echo ""

# ─── Dependency Checks ───────────────────────────────────────────────────────

# Bun is required — it compiles the binary
if ! command -v bun &> /dev/null; then
    fatal "bun is required but not installed."
    echo "  Install bun via: curl -fsSL https://bun.sh/install | bash" >&2
    echo "  Then re-run this installer." >&2
    exit 1
fi

BUN_VERSION=$(bun --version 2>/dev/null || echo "unknown")
ok "bun found: v${BUN_VERSION}"


# ─── Source ──────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/bneb/b4mal.git"

# If we're already inside the repo, build in-place.
# Otherwise, clone a shallow copy into a temp directory.
if [[ -f "./src/cli/index.ts" && -f "./package.json" ]]; then
    info "Building from local repository…"
    BUILD_DIR="."
    CLEANUP=false
else
    info "Cloning repository (shallow)…"
    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT
    git clone --depth 1 "$REPO_URL" "$TMP_DIR"
    BUILD_DIR="$TMP_DIR"
    CLEANUP=true
fi

# ─── Build ───────────────────────────────────────────────────────────────────

info "Installing dependencies…"
(cd "$BUILD_DIR" && bun install --frozen-lockfile 2>&1) || \
(cd "$BUILD_DIR" && bun install 2>&1)

info "Compiling standalone binary (bun build --compile)…"
(
    cd "$BUILD_DIR"
    bun build ./src/cli/index.ts \
        --compile \
        --outfile b4mal \
        --target bun \
        --minify
)

ok "Binary compiled: ${BUILD_DIR}/b4mal"

# ─── Install ─────────────────────────────────────────────────────────────────

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

if [[ "$BUILD_DIR" == "." ]]; then
    mv -f ./b4mal "$INSTALL_DIR/b4mal"
else
    mv -f "${BUILD_DIR}/b4mal" "$INSTALL_DIR/b4mal"
fi

chmod +x "$INSTALL_DIR/b4mal"
ok "Installed: ${INSTALL_DIR}/b4mal"

# ─── PATH Check ──────────────────────────────────────────────────────────────

if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
    warn "${INSTALL_DIR} is not in your PATH."
    echo ""
    echo "  Add it permanently:"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
        echo "    source ~/.zshrc"
    else
        echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
        echo "    source ~/.bashrc"
    fi
    echo ""
fi

# ─── Smoke Test ──────────────────────────────────────────────────────────────

if "$INSTALL_DIR/b4mal" --help &> /dev/null || \
   "$INSTALL_DIR/b4mal" 2>&1 | grep -q "b4mal"; then
    ok "Smoke test passed."
fi

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}  [OK] b4mal is installed!${RESET}"
echo ""
echo -e "  ${DIM}Quick start:${RESET}"
echo -e "    ${BOLD}b4mal demo${RESET}    — See the engine intercept a race condition live"
echo -e "    ${BOLD}b4mal init${RESET}    — Discover your project → b4mal.lock"
echo -e "    ${BOLD}b4mal build${RESET}   — Prove + execute your DAG (with caching)"
echo ""
