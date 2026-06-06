#!/bin/sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# B4MAL CORE INSTALLER
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# Usage:  curl -fsSL https://b4mal.dev/install.sh | sh
#
# Idempotent: safe to re-run. Preserves existing
# license keys and configuration on upgrade.
#
# POSIX-compliant. No bash-isms.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

# ── Configuration ─────────────────────────────────
VERSION="${B4MAL_VERSION:-v1.0.0}"
REPO="https://github.com/bneb/b4mal"
BASE_URL="${B4MAL_BASE_URL:-${REPO}/releases/download/${VERSION}}"
CONFIG_DIR="${HOME}/.b4mal"
INSTALL_DIR="${HOME}/.local/bin"

# ── Colors (gracefully degrade if no tty) ─────────
if [ -t 1 ]; then
    BLUE='\033[0;34m'
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'
else
    BLUE='' GREEN='' RED='' YELLOW='' BOLD='' DIM='' NC=''
fi

# ── Utility ───────────────────────────────────────
info()  { printf "${BLUE} ›${NC} %s\n" "$1"; }
ok()    { printf "${GREEN} ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW} [WARN] ${NC} %s\n" "$1"; }
fail()  { printf "${RED} [FAIL] ${NC} %s\n" "$1"; exit 1; }
line()  { printf "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"; }

# ── Header ────────────────────────────────────────
printf "\n"
line
printf "${BLUE}${BOLD}  B4MAL CORE INSTALLER${NC}\n"
printf "${DIM}  Logic-Aware CI Cache  •  ${VERSION}${NC}\n"
line
printf "\n"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 1: OS & Architecture Detection
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    Darwin)  PLATFORM="macos" ;;
    Linux)   PLATFORM="linux" ;;
    *)       fail "Unsupported OS: ${OS}. Only macOS and Linux are supported." ;;
esac

case "${ARCH}" in
    x86_64)        TARGET_ARCH="x64"   ;;
    arm64|aarch64) TARGET_ARCH="arm64" ;;
    *)             fail "Unsupported architecture: ${ARCH}. Only x64 and arm64 are supported." ;;
esac

BINARY_NAME="b4mal-${PLATFORM}-${TARGET_ARCH}"
DOWNLOAD_URL="${BASE_URL}/${BINARY_NAME}"

info "Detected: ${BOLD}${PLATFORM}-${TARGET_ARCH}${NC} (${OS} ${ARCH})"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 2: Directory Bootstrapping (Idempotent)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [ -d "${CONFIG_DIR}" ]; then
    ok "Config directory exists: ${CONFIG_DIR}"
else
    mkdir -p "${CONFIG_DIR}"
    ok "Created config directory: ${CONFIG_DIR}"
fi

mkdir -p "${INSTALL_DIR}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 3: Download Binary
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INSTALL_PATH="${INSTALL_DIR}/b4mal"

# Check for existing installation (upgrade path)
if [ -f "${INSTALL_PATH}" ]; then
    EXISTING_VERSION="$(${INSTALL_PATH} --version 2>/dev/null || echo 'unknown')"
    info "Upgrading: ${EXISTING_VERSION} → ${VERSION}"
else
    info "Fresh install: ${VERSION}"
fi

info "Fetching ${BOLD}${BINARY_NAME}${NC} ..."

# Use curl (preferred) or wget
if command -v curl >/dev/null 2>&1; then
    HTTP_CODE=$(curl -fsSL -w '%{http_code}' -o "${INSTALL_PATH}.tmp" "${DOWNLOAD_URL}" 2>/dev/null || echo "000")
    if [ "${HTTP_CODE}" = "000" ] || [ "${HTTP_CODE}" -ge 400 ] 2>/dev/null; then
        rm -f "${INSTALL_PATH}.tmp"
        fail "Download failed (HTTP ${HTTP_CODE}). URL: ${DOWNLOAD_URL}"
    fi
elif command -v wget >/dev/null 2>&1; then
    wget -q -O "${INSTALL_PATH}.tmp" "${DOWNLOAD_URL}" || fail "Download failed. URL: ${DOWNLOAD_URL}"
else
    fail "Neither curl nor wget found. Please install one and retry."
fi

# Atomic replace: only overwrite after successful download
mv "${INSTALL_PATH}.tmp" "${INSTALL_PATH}"
chmod +x "${INSTALL_PATH}"
ok "Installed to ${INSTALL_PATH}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 4: PATH Check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ok "PATH includes ${INSTALL_DIR}" ;;
    *)
        warn "${INSTALL_DIR} is not in your PATH"
        printf "\n"
        printf "  Add this to your shell profile (~/.zshrc or ~/.bashrc):\n"
        printf "  ${BOLD}export PATH=\"\${HOME}/.local/bin:\${PATH}\"${NC}\n"
        printf "\n"
        ;;
esac

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 5: License Discovery
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LICENSE_PATH="${CONFIG_DIR}/license.key"

if [ -f "${LICENSE_PATH}" ]; then
    ok "Core License detected"
else
    printf "\n"
    printf "${YELLOW}${BOLD}  ACTION REQUIRED: ACTIVATE LICENSE${NC}\n"
    line
    printf "  Drop your ${GREEN}license.key${NC} into:\n"
    printf "    ${BOLD}${LICENSE_PATH}${NC}\n"
    printf "\n"
    printf "  Or run:\n"
    printf "    ${BOLD}b4mal activate <your-license-key>${NC}\n"
    printf "\n"
    printf "  Get a key at ${BOLD}https://b4mal.dev${NC}\n"
    line
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 6: Verify Installation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n"
line
printf "${GREEN}${BOLD}  [OK]  B4MAL ${VERSION} INSTALLED${NC}\n"
line
printf "\n"
printf "  Quick start:\n"
printf "    ${BOLD}b4mal audit${NC}            — Scan your git history\n"
printf "    ${BOLD}b4mal audit --rust${NC}      — Rust-specific deep audit\n"
printf "    ${BOLD}b4mal run config.ts${NC}     — Execute a pipeline\n"
printf "    ${BOLD}b4mal --help${NC}            — Full command reference\n"
printf "\n"
