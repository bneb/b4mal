#!/usr/bin/env bash
# scripts/crucible_deploy.sh — Deploy and run the b4mal crucible on a remote Linux node
#
# Usage:
#   bash scripts/crucible_deploy.sh [user@]host [password]
#
# Examples:
#   bash scripts/crucible_deploy.sh main@192.168.68.68
#   bash scripts/crucible_deploy.sh main@192.168.68.68 MyPassword123
#
# The script:
#   1. Installs SSH key for passwordless access (if password provided)
#   2. Installs Z3 + Node (apt-get)
#   3. rsyncs the repo (excluding node_modules, .git, crucible_workspace)
#   4. Runs bun install
#   5. Runs the crucible benchmark and tees output to a timestamped log

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────

TARGET="${1:-}"
PASSWORD="${2:-}"

if [[ -z "$TARGET" ]]; then
    echo "Usage: $0 [user@]host [password]"
    exit 1
fi

HOST="${TARGET##*@}"
USER="${TARGET%%@*}"
if [[ "$USER" == "$HOST" ]]; then
    USER="$(whoami)"
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
REMOTE_DIR="~/b4mal"
LOG="crucible_$(date +%Y%m%d_%H%M%S).log"

echo "B4mal Crucible — Remote Deploy"
echo "   Target : $USER@$HOST"
echo "   Log    : $LOG"
echo ""

# ── Helper: run remote command ────────────────────────────────────────────────

remote() {
    ssh $SSH_OPTS "$USER@$HOST" "$@"
}

remote_sudo() {
    if [[ -n "$PASSWORD" ]]; then
        ssh $SSH_OPTS "$USER@$HOST" "echo '$PASSWORD' | sudo -S $*"
    else
        ssh $SSH_OPTS "$USER@$HOST" "sudo $*"
    fi
}

# ── Step 1: Install SSH key (skip if already working) ────────────────────────

echo "[1/5] Setting up SSH key..."
PUBKEY="$(cat ~/.ssh/id_rsa.pub 2>/dev/null || cat ~/.ssh/id_ed25519.pub 2>/dev/null || echo '')"

if [[ -n "$PUBKEY" && -n "$PASSWORD" ]]; then
    ssh $SSH_OPTS "$USER@$HOST" \
        "mkdir -p ~/.ssh && echo '$PUBKEY' >> ~/.ssh/authorized_keys && sort -u -o ~/.ssh/authorized_keys ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys" \
        <<< "$PASSWORD" 2>/dev/null || true
    echo "   [OK] Key installed"
else
    echo "   [WARN] No password provided — assuming SSH key is already set up"
fi

# ── Step 2: Install system deps ───────────────────────────────────────────────

echo "[2/5] Installing Z3 + Node..."
remote_sudo "apt-get install -y -q z3 nodejs 2>&1 | tail -2"
Z3VER="$(remote 'z3 --version' 2>&1)"
echo "   [OK] $Z3VER"

# ── Step 3: Sync repo ─────────────────────────────────────────────────────────

echo "[3/5] Syncing b4mal repo..."
rsync -az \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='crucible_workspace' \
    --exclude='*.log' \
    -e "ssh $SSH_OPTS" \
    "$(git rev-parse --show-toplevel)/" \
    "$USER@$HOST:$REMOTE_DIR/"
echo "   [OK] Synced"

# ── Step 4: bun install ───────────────────────────────────────────────────────

echo "[4/5] Installing npm packages..."
remote "cd $REMOTE_DIR && bun install 2>&1 | tail -3"
echo "   [OK] Packages installed"

# ── Step 5: Run crucible ──────────────────────────────────────────────────────

echo "[5/5] Launching crucible..."
echo "   (This will take 3-5 minutes. Output teed to $LOG)"
echo ""

remote "cd $REMOTE_DIR && bun run src/benchmarks/crucible.ts 2>&1" | tee "$LOG"

echo ""
echo "[OK] Done. Full results saved to: $LOG"
