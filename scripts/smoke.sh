#!/usr/bin/env bash
#
# End-to-end smoke test against a running DataNest instance.
#
# Used by CI on every push and by the Deploy workflow against the live host, so
# "it works" means the same thing in both places. Covers the journey that
# actually matters: sign up, create a vault, mint an invite, resolve it as a
# stranger, join, read shared data, and confirm the link is single-use.
#
# Usage: scripts/smoke.sh http://127.0.0.1:8080

set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
    printf '  ok    %s\n' "$label"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s (expected %s, got %s)\n' "$label" "$expected" "$actual"
  fi
}

json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);console.log(eval('o.'+process.argv[1]))})" "$1"; }

echo "Smoke testing $BASE"
echo

echo "Health and shell"
check "health endpoint" "true" "$(curl -fsS --max-time 10 "$BASE/healthz" | json 'ok' )"
check "app shell served" "1" "$(curl -fsS --max-time 10 "$BASE/" | grep -c '<div id="root">' || true)"
check "anonymous vault access refused" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/vault")"

echo
echo "Owner journey"
OWNER="$TMP/owner.txt"
EMAIL="smoke$(date +%s)-$$@example.com"
check "signup" "201" "$(curl -s -o /dev/null -w '%{http_code}' -c "$OWNER" \
  -X POST "$BASE/api/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"smoke test password\",\"name\":\"Smoke\"}")"

check "quota is 1 TiB" "1099511627776" "$(curl -fsS -b "$OWNER" "$BASE/api/vault" | json 'quota.quotaBytes')"

VAULT=$(curl -fsS -b "$OWNER" -X POST "$BASE/api/workspaces" \
  -H 'content-type: application/json' -d '{"name":"Smoke vault"}')
WS=$(echo "$VAULT" | json 'workspace.id')
check "shared vault created" "1" "$(echo "$WS" | grep -c '^ws-')"

curl -fsS -b "$OWNER" -X POST "$BASE/api/records?ws=$WS" -H 'content-type: application/json' \
  -d '{"kind":"note","title":"Smoke note","content":"shared"}' > /dev/null
check "owner wrote a record" "Smoke note" \
  "$(curl -fsS -b "$OWNER" "$BASE/api/records?ws=$WS" | json 'items[0].title')"

echo
echo "Invite link"
INVITE=$(curl -fsS -b "$OWNER" -X POST "$BASE/api/workspace/invites?ws=$WS" \
  -H 'content-type: application/json' -d '{"role":"editor"}')
TOKEN=$(echo "$INVITE" | json 'token')
PATH_=$(echo "$INVITE" | json 'path')
URL=$(echo "$INVITE" | json 'url')

check "invite path carries the workspace" "1" "$(echo "$PATH_" | grep -c "^/join/$WS/")"

# An absolute URL is required for a link someone can open elsewhere. Without
# DATANEST_ORIGIN the server has no way to know its public address, so it
# returns a relative path - correct for local use, useless in WhatsApp. Treat a
# configured origin as a hard requirement, and a bare deployment as a warning.
CONFIG_ORIGIN=$(curl -fsS "$BASE/api/config" | json 'origin')
case "$URL" in
  http://*|https://*) check "invite URL is absolute" "1" "1" ;;
  *)
    if [ "$CONFIG_ORIGIN" != "null" ] && [ -n "$CONFIG_ORIGIN" ]; then
      check "invite URL is absolute (origin is $CONFIG_ORIGIN)" "1" "0 ($URL)"
    else
      check "invite URL absolute (no DATANEST_ORIGIN set, relative is expected)" "1" "1"
      echo "  note  set DATANEST_ORIGIN to the public address for shareable links"
    fi
    ;;
esac

check "preview works for a stranger" "Smoke vault" \
  "$(curl -fsS "$BASE/api/invites/$WS/$TOKEN" | json 'workspaceName')"
check "anonymous accept refused" "401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/invites/$WS/$TOKEN" \
     -H 'content-type: application/json' -d '{}')"

echo
echo "Recipient journey"
GUEST="$TMP/guest.txt"
GEMAIL="guest$(date +%s)-$$@example.com"
curl -fsS -o /dev/null -c "$GUEST" -X POST "$BASE/api/auth/signup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$GEMAIL\",\"password\":\"guest test password\",\"name\":\"Guest\"}"

check "recipient joins" "editor" \
  "$(curl -fsS -b "$GUEST" -X POST "$BASE/api/invites/$WS/$TOKEN" \
     -H 'content-type: application/json' -d '{}' | json 'role')"
check "recipient sees shared data" "Smoke note" \
  "$(curl -fsS -b "$GUEST" "$BASE/api/records?ws=$WS" | json 'items[0].title')"
check "link is single use" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/invites/$WS/$TOKEN" \
     -b "$GUEST" -H 'content-type: application/json' -d '{}')"

echo
echo "The page behind the link can boot"
ASSET=$(curl -fsS "$BASE$PATH_" | grep -o './assets/[^"]*\.js' | head -1)
if [ -n "$ASSET" ]; then
  REL="${ASSET#./}"
  check "script resolves from the deep route" "200" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$PATH_/$REL")"
  check "script is served as JavaScript" "1" \
    "$(curl -s -o /dev/null -w '%{content_type}' "$BASE$PATH_/$REL" | grep -c 'javascript')"
else
  check "shell references a script" "1" "0"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "$pass passed, $fail FAILED"
  exit 1
fi
echo "$pass passed, 0 failed"
