#!/bin/bash
# Hacknet liveness checks. One line per check.
# Set DEBUG=1 to see context on success too.
set -u

DEBUG="${DEBUG:-0}"
FAILED=0
TOTAL=0

G='\033[1;32m'; R='\033[1;31m'; D='\033[0;90m'; N='\033[0m'

# check NAME RC [CONTEXT]
#   RC: 0 = pass, non-zero = fail (shell convention)
#   CONTEXT: detail printed on fail (or on pass when DEBUG=1)
check() {
    local name="$1" rc="$2" ctx="${3-}"
    TOTAL=$((TOTAL + 1))
    if [ "$rc" -eq 0 ]; then
        echo -e "${G}✓${N} $name"
        if [ "$DEBUG" = "1" ] && [ -n "$ctx" ]; then
            echo "$ctx" | sed "s/^/  /"
        fi
    else
        FAILED=$((FAILED + 1))
        echo -e "${R}✗${N} $name"
        if [ -n "$ctx" ]; then
            echo "$ctx" | head -20 | sed "s/^/  /"
        fi
    fi
    return 0
}

# 1. Bitcoin RPC live
btc_resp=$(curl -sf -u "hacknet:hacknet" --data-binary '{"jsonrpc":"1.0","method":"getblockcount","params":[]}' -H 'content-type: text/plain;' "http://localhost:18443/" 2>&1 || true)
btc_height=$(echo "$btc_resp" | jq -r '.result // empty' 2>/dev/null)
if [ -n "$btc_height" ]; then
    check "bitcoin RPC live (height=$btc_height)" 0 "$btc_resp"
else
    check "bitcoin RPC live" 1 "$btc_resp"
fi

# 2. Bitcoin mineable
mine_resp=$(curl -sf -u "hacknet:hacknet" --data-binary '{"jsonrpc":"1.0","method":"generatetoaddress","params":[1,"mqVnk6NPRdhntvfm4hh9vvjiRkFDUuSYsH"]}' -H 'content-type: text/plain;' "http://localhost:18443/" 2>&1 || true)
if echo "$mine_resp" | jq -e '.error == null' >/dev/null 2>&1; then
    check "bitcoin mineable" 0 "$mine_resp"
else
    check "bitcoin mineable" 1 "$mine_resp"
fi

# 3. Postgres ready
pg_out=$(docker exec postgres pg_isready 2>&1 || true)
if echo "$pg_out" | grep -q "accepting connections"; then
    check "postgres ready" 0 "$pg_out"
else
    check "postgres ready" 1 "$pg_out"
fi

# 4. Nakamoto signer spawned
signer_logs=$(docker logs stacks-signer-1 2>/dev/null || true)
if echo "$signer_logs" | grep -qF "Signer spawned successfully"; then
    check "signer spawned" 0
else
    check "signer spawned" 1 "(no 'Signer spawned successfully' in stacks-signer-1 logs)"
fi

# 5–7. Stacks miners /v2/info
for i in 1 2 3; do
    port=$((19443 + i * 1000))
    body=$(curl -sf -m 5 "http://localhost:${port}/v2/info" 2>&1 || true)
    if [ -n "$body" ] && echo "$body" | jq -e '.stacks_tip_height' >/dev/null 2>&1; then
        h=$(echo "$body" | jq -r '.stacks_tip_height')
        check "stacks miner $i live (tip=$h)" 0 "$body"
    else
        check "stacks miner $i live" 1 "$body"
    fi
done

# 8. Stacks tip > 0
info=$(curl -sf -m 5 "http://localhost:20443/v2/info" 2>&1 || true)
tip=$(echo "$info" | jq -r '.stacks_tip_height // 0' 2>/dev/null)
tip="${tip:-0}"
if [ "$tip" -gt 0 ] 2>/dev/null; then
    check "stacks tip > 0 (tip=$tip)" 0 "$info"
else
    check "stacks tip > 0" 1 "$info"
fi

# 9. Stacks API event observer
evt=$(curl -sf -m 5 "http://localhost:3700" 2>&1 || true)
if echo "$evt" | jq -e '.status == "ready"' >/dev/null 2>&1; then
    check "stacks-api event observer ready" 0 "$evt"
else
    check "stacks-api event observer ready" 1 "$evt"
fi

# 10. Stacks public API
if curl -sf -m 5 -o /dev/null "http://localhost:3999/extended/"; then
    check "stacks-api public endpoint" 0
else
    check "stacks-api public endpoint" 1 "GET http://localhost:3999/extended/ did not return 2xx"
fi

# 11. Stacks-API connected to postgres
api_logs=$(docker logs stacks-api 2>/dev/null || true)
if echo "$api_logs" | grep -qF "PgNotifier connected"; then
    check "stacks-api connected to postgres" 0
else
    check "stacks-api connected to postgres" 1 "(no 'PgNotifier connected' in stacks-api logs)"
fi

# Summary
echo
if [ "$FAILED" -eq 0 ]; then
    echo -e "${G}all $TOTAL checks passed${N}"
    exit 0
else
    echo -e "${R}$FAILED/$TOTAL checks failed${N}"
    exit 1
fi
