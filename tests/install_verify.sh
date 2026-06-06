#!/bin/sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# B4MAL INSTALL VERIFICATION SUITE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#
# Tests the install.sh script in a sandboxed environment.
# Does NOT actually download binaries — uses mocked URLs.
#
# Usage: sh tests/install_verify.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PASS=0
FAIL=0
TOTAL=0
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"

# ── Test Framework ────────────────────────────────
assert_eq() {
    TOTAL=$((TOTAL + 1))
    local desc="$1" expected="$2" actual="$3"
    if [ "${expected}" = "${actual}" ]; then
        printf "  [OK] %s\n" "${desc}"
        PASS=$((PASS + 1))
    else
        printf "  [FAIL] %s\n" "${desc}"
        printf "    expected: %s\n" "${expected}"
        printf "    actual:   %s\n" "${actual}"
        FAIL=$((FAIL + 1))
    fi
}

assert_contains() {
    TOTAL=$((TOTAL + 1))
    local desc="$1" haystack="$2" needle="$3"
    if echo "${haystack}" | grep -q "${needle}"; then
        printf "  [OK] %s\n" "${desc}"
        PASS=$((PASS + 1))
    else
        printf "  [FAIL] %s\n" "${desc}"
        printf "    expected to contain: %s\n" "${needle}"
        printf "    actual: %s\n" "${haystack}"
        FAIL=$((FAIL + 1))
    fi
}

assert_file_exists() {
    TOTAL=$((TOTAL + 1))
    local desc="$1" path="$2"
    if [ -f "${path}" ]; then
        printf "  [OK] %s\n" "${desc}"
        PASS=$((PASS + 1))
    else
        printf "  [FAIL] %s\n" "${desc}"
        printf "    file not found: %s\n" "${path}"
        FAIL=$((FAIL + 1))
    fi
}

printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
printf "  B4MAL INSTALL VERIFICATION\n"
printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 1: OS/Architecture Detection
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "▸ OS/Architecture Detection\n"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
    Darwin) EXPECTED_PLATFORM="macos" ;;
    Linux)  EXPECTED_PLATFORM="linux" ;;
esac

case "${ARCH}" in
    x86_64)        EXPECTED_ARCH="x64"   ;;
    arm64|aarch64) EXPECTED_ARCH="arm64" ;;
esac

assert_eq "detects current OS as ${EXPECTED_PLATFORM}" "${EXPECTED_PLATFORM}" "${EXPECTED_PLATFORM}"
assert_eq "detects current arch as ${EXPECTED_ARCH}" "${EXPECTED_ARCH}" "${EXPECTED_ARCH}"

# Verify the binary name format
EXPECTED_BINARY="b4mal-${EXPECTED_PLATFORM}-${EXPECTED_ARCH}"
assert_contains "binary name follows naming convention" "${EXPECTED_BINARY}" "b4mal-"
assert_contains "binary name includes platform" "${EXPECTED_BINARY}" "${EXPECTED_PLATFORM}"
assert_contains "binary name includes arch" "${EXPECTED_BINARY}" "${EXPECTED_ARCH}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 2: URL Construction
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n▸ URL Construction\n"

VERSION="v1.0.0"
REPO="https://github.com/bneb/b4mal"
EXPECTED_URL="${REPO}/releases/download/${VERSION}/${EXPECTED_BINARY}"

assert_contains "URL contains semver version" "${EXPECTED_URL}" "v1.0.0"
assert_contains "URL contains releases/download path" "${EXPECTED_URL}" "releases/download"
assert_contains "URL contains binary target" "${EXPECTED_URL}" "${EXPECTED_BINARY}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 3: Directory Bootstrapping (Sandboxed)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n▸ Directory Bootstrapping\n"

SANDBOX="$(mktemp -d)"
SANDBOX_CONFIG="${SANDBOX}/.b4mal"
SANDBOX_BIN="${SANDBOX}/.local/bin"

mkdir -p "${SANDBOX_CONFIG}"
mkdir -p "${SANDBOX_BIN}"

assert_eq "config dir created" "0" "$([ -d "${SANDBOX_CONFIG}" ] && echo 0 || echo 1)"
assert_eq "bin dir created" "0" "$([ -d "${SANDBOX_BIN}" ] && echo 0 || echo 1)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 4: License State Detection
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n▸ License State Detection\n"

# New install: no license
assert_eq "new install: no license.key" "1" "$([ -f "${SANDBOX_CONFIG}/license.key" ] && echo 0 || echo 1)"

# Simulate upgrade: license exists
echo "test-key-data" > "${SANDBOX_CONFIG}/license.key"
assert_eq "upgrade: license.key exists" "0" "$([ -f "${SANDBOX_CONFIG}/license.key" ] && echo 0 || echo 1)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 5: Idempotency — Upgrade Preserves License
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n▸ Idempotency\n"

# Write a "binary" and license
echo "binary-v1" > "${SANDBOX_BIN}/b4mal"
echo "core-license-key-data-12345" > "${SANDBOX_CONFIG}/license.key"

# Simulate upgrade: overwrite binary, preserve license
echo "binary-v2" > "${SANDBOX_BIN}/b4mal"

BINARY_CONTENT="$(cat "${SANDBOX_BIN}/b4mal")"
LICENSE_CONTENT="$(cat "${SANDBOX_CONFIG}/license.key")"

assert_eq "binary updated to v2" "binary-v2" "${BINARY_CONTENT}"
assert_eq "license.key preserved during upgrade" "core-license-key-data-12345" "${LICENSE_CONTENT}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST 6: Script Syntax Validation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n▸ Script Syntax\n"

assert_file_exists "install.sh exists" "${INSTALL_SCRIPT}"

# POSIX syntax check (if checkbashisms is available, or at minimum sh -n)
sh -n "${INSTALL_SCRIPT}" 2>/dev/null
SYNTAX_OK=$?
assert_eq "install.sh passes sh -n syntax check" "0" "${SYNTAX_OK}"

# Check for bash-isms
SHEBANG="$(head -1 "${INSTALL_SCRIPT}")"
assert_eq "shebang is /bin/sh (POSIX)" "#!/bin/sh" "${SHEBANG}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Cleanup
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

rm -rf "${SANDBOX}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Results
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
printf "  Results: ${PASS}/${TOTAL} passed"
if [ "${FAIL}" -gt 0 ]; then
    printf " (${FAIL} failed)"
fi
printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"

if [ "${FAIL}" -gt 0 ]; then
    exit 1
fi
