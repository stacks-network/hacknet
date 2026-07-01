#!/bin/bash
# Hacknet liveness checks. One line per check.
# Set DEBUG=1 to see context on success too.
set -u

DEBUG="${DEBUG:-0}"
STACKS_40_HEIGHT="${STACKS_40_HEIGHT:-262}"
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

# 12. PoX-5 setup helper did not fail
pox5_setup_state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' pox5-setup 2>/dev/null || true)
case "$pox5_setup_state" in
    running*|exited\ 0)
        check "pox5-setup not failed" 0 "$pox5_setup_state"
        ;;
    *)
        check "pox5-setup not failed" 1 "${pox5_setup_state:-pox5-setup container not found}"
        ;;
esac

bitcoin_staking_state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' bitcoin-staking 2>/dev/null || true)
if [ -n "$bitcoin_staking_state" ]; then
    case "$bitcoin_staking_state" in
        running*|exited\ 0)
            check "bitcoin-staking not failed" 0 "$bitcoin_staking_state"
            ;;
        *)
            check "bitcoin-staking not failed" 1 "$bitcoin_staking_state"
            ;;
    esac
fi

# 13+. PoX-5 checks, only required after Epoch 4.0 activation
burn_height=$(echo "$info" | jq -r '.burn_block_height // 0' 2>/dev/null)
burn_height="${burn_height:-0}"
if [ "$burn_height" -ge "$STACKS_40_HEIGHT" ] 2>/dev/null; then
    pox=$(curl -sf -m 5 "http://localhost:20443/v2/pox" 2>&1 || true)
    pox_contract=$(echo "$pox" | jq -r '.contract_id // empty' 2>/dev/null)
    if [[ "$pox_contract" == *.pox-5 ]]; then
        check "active PoX contract is pox-5" 0 "$pox"
    else
        check "active PoX contract is pox-5" 1 "$pox"
    fi

    for contract in \
        "ST2SBXRBJJTH7GV5J93HJ62W2NRRQ46XYBK92Y039/sbtc-registry" \
        "ST2SBXRBJJTH7GV5J93HJ62W2NRRQ46XYBK92Y039/sbtc-token" \
        "ST24VB7FBXCBV6P0SRDSPSW0Y2J9XHDXNHW9Q8S7H/pox5-signer-0" \
        "ST2XAK68AR2TKBQBFNYSK9KN2AY9CVA91A7CSK63Z/pox5-signer-1" \
        "ST1J9R0VMA5GQTW65QVHW1KVSKD7MCGT27X37A551/pox5-signer-2"
    do
        contract_addr="${contract%/*}"
        contract_name="${contract#*/}"
        contract_resp=$(curl -sf -m 5 "http://localhost:20443/v2/contracts/source/${contract_addr}/${contract_name}" 2>&1 || true)
        if echo "$contract_resp" | jq -e '.source | length > 0' >/dev/null 2>&1; then
            check "contract deployed ${contract_addr}.${contract_name}" 0
        else
            check "contract deployed ${contract_addr}.${contract_name}" 1 "$contract_resp"
        fi
    done

    waterfall_errors=$(docker logs stacks-miner-1 2>/dev/null | grep -E "Invalid waterfall block commit|Expected reward set to be present during waterfall" || true)
    if [ -z "$waterfall_errors" ]; then
        check "no waterfall commit errors" 0
    else
        check "no waterfall commit errors" 1 "$waterfall_errors"
    fi
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
