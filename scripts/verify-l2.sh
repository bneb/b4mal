#!/usr/bin/env bash
# Verify the L2 remote cache against real object storage.
#
# The test suite exercises L2 against an in-memory stub (tests/fixtures/s3_stub.ts).
# That proves the code path; it cannot prove a real S3-compatible endpoint accepts
# the requests, stores the bytes and returns them intact. This does.
#
# Usage:
#   B4MAL_CACHE_BUCKET=my-bucket \
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#   AWS_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
#   B4MAL_CACHE_ORG=_b4mal-verify \
#   ./scripts/verify-l2.sh
#
# B4MAL_CACHE_ORG is your namespace inside the bucket: everything this script
# creates lives under `b4mal/<org>/` and is deleted on exit, including on failure.
# Use a dedicated value — never run it without one, or it writes to the default
# shared prefix.
#
# What it checks:
#   1. push lands an artifact in the bucket
#   2. with L1 wiped, a rebuild restores it over the network WITHOUT re-executing
#   3. a pull signed with a different secret is rejected
#   4. an object tampered with in the bucket is rejected
#   5. the prefix is empty afterwards
#
# Exits non-zero if any check fails.

set -uo pipefail

: "${B4MAL_CACHE_BUCKET:?set B4MAL_CACHE_BUCKET}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
: "${AWS_S3_ENDPOINT:?set AWS_S3_ENDPOINT}"
: "${B4MAL_CACHE_ORG:?set B4MAL_CACHE_ORG to a namespace you own}"

BUCKET="$B4MAL_CACHE_BUCKET"
PREFIX="b4mal/${B4MAL_CACHE_ORG}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO_ROOT/src/cli/index.ts"
WORK="$(mktemp -d)"
FAILURES=0
SECRET="verify-$(date +%s)"

step()  { printf '\n=== %s ===\n' "$1"; }
ok()    { printf '  [OK]   %s\n' "$1"; }
bad()   { printf '  [FAIL] %s\n' "$1"; FAILURES=$((FAILURES+1)); }

# aws is used only for inspection and cleanup, so it is not on b4mal's critical path.
command -v aws >/dev/null || { echo "aws CLI required for inspection/cleanup"; exit 2; }
aws_() { aws s3api "$@" --endpoint-url "$AWS_S3_ENDPOINT" 2>&1; }

# NOTE: R2 does not return KeyCount in ListObjectsV2 (response carries only
# Contents/RequestCharged/Prefix/NextToken), so "KeyCount: None" means "field
# absent", NOT "no objects". Always count real keys.
keys_under_prefix() {
  aws_ list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" \
       --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -v '^None$' || true
}

cleanup() {
  step "CLEANUP"
  local k
  for k in $(keys_under_prefix); do
    aws_ delete-object --bucket "$BUCKET" --key "$k" >/dev/null
    echo "  deleted: $k"
  done
  if [ -z "$(keys_under_prefix)" ]; then
    ok "no objects remain under ${PREFIX}/ (verified by key listing)"
  else
    bad "objects remain under ${PREFIX}/"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── fixture ─────────────────────────────────────────────────────────────────
mkdir -p "$WORK"; cd "$WORK"
cat > b4mal.config.json <<'JSON'
{ "tasks": { "gen": {
  "cmd": ["sh", "-c", "echo ran >> exec.log; mkdir -p out; echo restored > out/a.txt"],
  "outputs": ["out/a.txt"] } } }
JSON
export B4MAL_DB_PATH="$WORK/.b4mal/cache.db"
execs() { [ -f exec.log ] && wc -l < exec.log | tr -d ' ' || echo 0; }

step "1. signed push to ${PREFIX}/"
B4MAL_CACHE_SECRET="$SECRET" bun "$CLI" build --force >/dev/null 2>&1
echo "  task executions: $(execs)"
KEY="$(keys_under_prefix | head -1)"
if [ -n "$KEY" ]; then ok "artifact stored: $KEY"; else bad "nothing was pushed"; fi

step "2. wipe L1, rebuild — must restore over the network, not re-execute"
rm -rf "$WORK/.b4mal" "$WORK/out"
B4MAL_CACHE_SECRET="$SECRET" bun "$CLI" build >/dev/null 2>&1
if [ "$(execs)" = "1" ] && [ -f out/a.txt ]; then
  ok "restored from remote cache; task did not re-execute"
else
  bad "expected 1 execution and a restored output, got $(execs) execution(s)"
fi

step "3. wrong secret — must be rejected"
rm -rf "$WORK/.b4mal" "$WORK/out"
B4MAL_CACHE_SECRET="not-the-right-secret" bun "$CLI" build >/dev/null 2>&1
if [ "$(execs)" = "2" ]; then ok "rejected; task re-ran"; else bad "accepted an artifact signed with a different secret"; fi

step "4. tamper with the stored object — must be rejected"
if [ -n "$KEY" ]; then
  aws_ get-object --bucket "$BUCKET" --key "$KEY" "$WORK/orig" >/dev/null
  bun -e '
    const u = new Uint8Array(await Bun.file(process.argv[1]).arrayBuffer());
    const s = Math.floor(u.length / 2);
    for (let i = s; i < Math.min(s + 64, u.length); i++) u[i] ^= 0xFF;
    await Bun.write(process.argv[2], u);
  ' "$WORK/orig" "$WORK/bad"
  aws_ put-object --bucket "$BUCKET" --key "$KEY" --body "$WORK/bad" >/dev/null
  rm -rf "$WORK/.b4mal" "$WORK/out"
  B4MAL_CACHE_SECRET="$SECRET" bun "$CLI" build >/dev/null 2>&1
  if [ "$(execs)" = "3" ]; then ok "tampered artifact rejected; task re-ran"; else bad "tampered artifact was accepted"; fi
else
  bad "no key to tamper with"
fi

step "RESULT"
if [ "$FAILURES" -eq 0 ]; then echo "  All L2 checks passed against $AWS_S3_ENDPOINT"; else echo "  $FAILURES check(s) failed"; fi
exit "$FAILURES"
