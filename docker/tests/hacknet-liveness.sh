#!/bin/bash
# Hacknet liveness checks. One line per check.
# Set DEBUG=1 to see raw responses/log excerpts on success too.
set -uo pipefail

DEBUG="${DEBUG:-0}"
FAILED=0
TOTAL=0

G='\033[1;32m'; R='\033[1;31m'; D='\033[0;90m'; N='\033[0m'

# check NAME PASS_BOOL [CONTEXT]
#   PASS_BOOL: "1"/"true" = pass, anything else = fail
#   CONTEXT:   optional detail (printed on fail, or on pass when DEBUG=1)
check() {
    local name="$1" ok="$2" ctx="${3:-}"
    TOTAL=$((TOTAL + 1))
    if [ "$ok" = "1" ] || [ "$ok" = "true" ]; then
        echo -e "${G}✓${N} $name"
        [ "$DEBUG" = "1" ] && [ -n "$ctx" ] && echo -e "${D}  $ctx${N}"
    else
        FAILED=$((FAILED + 1))
        echo -e "${R}✗${N} $name"
        [ -n "$ctx" ] && echo -e "${D}  $ctx${N}" | head -20
    fi
}

# 1. Bitcoin RPC live
btc_resp=$(curl -sf -u "hacknet:hacknet" --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[]}' -H 'content-type: text/plain;' "http://localhost:18443/" 2>&1 || true)
btc_height=$(echo "$btc_resp" | jq -r '.result // empty' 2>/dev/null)
[ -n "$btc_height" ] && check "bitcoin RPC live (height=$btc_height)" 1 "$btc_resp" || check "bitcoin RPC live" 0 "$btc_resp"

# 2. Bitcoin mineable
mine_resp=$(curl -sf -u "hacknet:hacknet" --data-binary '{"jsonrpc":"1.0","method":"generatetoaddress","params":[1,"mqVnk6NPRdhntvfm4hh9vvjiRkFDUuSYsH"]}' -H 'content-type: text/plain;' "http://localhost:18443/" 2>&1 || true)
echo "$mine_resp" | jq -e '.error == null' >/dev/null 2>&1
check "bitcoin mineable" $? "$mine_resp"

# 3. Postgres ready
pg_out=$(docker exec postgres pg_isready 2>&1 || true)
echo "$pg_out" | grep -q "accepting connections"
check "postgres ready" $? "$pg_out"

# 4. Nakamoto signer spawned
signer_logs=$(docker logs stacks-signer-1 2>/dev/null | grep -F "Signer spawned successfully" | tail -1)
[ -n "$signer_logs" ]
check "signer spawned" $? "(no 'Signer spawned successfully' in stacks-signer-1 logs)"

# 5–7. Stacks miners /v2/info
for i in 1 2 3; do
    port=$((19443 + i * 1000))
    body=$(curl -sf -m 5 "http://localhost:${port}/v2/info" 2>&1 || true)
    if [ -n "$body" ] && echo "$body" | jq -e '.stacks_tip_height' >/dev/null 2>&1; then
        h=$(echo "$body" | jq -r '.stacks_tip_height')
        check "stacks miner $i live (tip=$h)" 1 "$body"
    else
        check "stacks miner $i live" 0 "$body"
    fi
done

# 8. Stacks tip > 0 (chain progressing past genesis)
info=$(curl -sf -m 5 "http://localhost:20443/v2/info" 2>&1 || true)
tip=$(echo "$info" | jq -r '.stacks_tip_height // 0' 2>/dev/null)
[ "${tip:-0}" -gt 0 ] 2>/dev/null
check "stacks tip > 0 (tip=$tip)" $? "$info"

# 9. Stacks API event observer
evt=$(curl -sf -m 5 "http://localhost:3700" 2>&1 || true)
echo "$evt" | jq -e '.status == "ready"' >/dev/null 2>&1
check "stacks-api event observer ready" $? "$evt"

# 10. Stacks public API
api_code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:3999/extended/" || echo "000")
[ "$api_code" = "200" ]
check "stacks-api public endpoint (HTTP $api_code)" $? "expected 200, got $api_code"

# 11. Stacks-API connected to postgres
api_pg=$(docker logs stacks-api 2>/dev/null | grep -F "PgNotifier connected" | tail -1)
[ -n "$api_pg" ]
check "stacks-api connected to postgres" $? "(no 'PgNotifier connected' in stacks-api logs)"

# Summary
echo
if [ $FAILED -eq 0 ]; then
    echo -e "${G}all $TOTAL checks passed${N}"
    exit 0
else
    echo -e "${R}$FAILED/$TOTAL checks failed${N}"
    exit 1
fi
