#!/usr/bin/env bash
# Sends identical transactions to the Stylus and Solidity counters and prints a markdown table.
# Needs: STYLUS_ADDR SOL_ADDR BENCH_KEY SOL_DEPLOY_GAS, plus cast and jq. Reads gasUsed and gasUsedForL1 straight
# from the raw receipts: on Arbitrum, gasUsed includes a data-posting component (gasUsedForL1) that does not depend on
# the contract's language, so we report the execution part (gasUsed - gasUsedForL1) as well.
set -euo pipefail
rpc=${RPC_URL:-http://127.0.0.1:8547}
WORK_N=${WORK_N:-20000}

# prints "total l2" for one confirmed transaction
tx() {
  local to=$1 sig=$2; shift 2
  local hash receipt gas l1
  hash=$(cast send "$to" "$sig" "$@" --rpc-url "$rpc" --private-key "$BENCH_KEY" --json | jq -r .transactionHash)
  receipt=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$rpc")
  test "$(echo "$receipt" | jq -r .status)" = "0x1" || { echo "tx reverted: $hash" >&2; exit 1; }
  gas=$(printf '%d' "$(echo "$receipt" | jq -r .gasUsed)")
  l1=$(printf '%d' "$(echo "$receipt" | jq -r '.gasUsedForL1 // "0x0"')")
  echo "$gas $((gas - l1))"
}

measure() {
  local label=$1 to=$2
  read -r first_t first_l <<<"$(tx "$to" 'increment()')"
  local steady_l=() steady_t=()
  for _ in 1 2 3; do
    read -r t l <<<"$(tx "$to" 'increment()')"
    steady_t+=("$t"); steady_l+=("$l")
  done
  read -r _ add_l <<<"$(tx "$to" 'addNumber(uint256)' 7)"
  read -r _ set_l <<<"$(tx "$to" 'setNumber(uint256)' 100)"
  read -r work_t work_l <<<"$(tx "$to" 'work(uint64)' "$WORK_N")"
  local result size
  result=$(cast call "$to" 'work(uint64)(uint64)' "$WORK_N" --rpc-url "$rpc")
  size=$(( ($(cast code "$to" --rpc-url "$rpc" | wc -c) - 3) / 2 ))
  echo "$label|$first_t|$first_l|${steady_l[*]}|$add_l|$set_l|$work_l|$work_t|$result|$size"
}

s=$(measure Stylus "$STYLUS_ADDR")
v=$(measure Solidity "$SOL_ADDR")

echo "### Stylus vs Solidity on a local Nitro dev node"
echo
echo "Execution gas = \`gasUsed - gasUsedForL1\` from each receipt (the L1 data-posting part is language-independent)."
echo
echo "| | increment 0→1 (total / exec) | increment steady x3 (exec) | addNumber (exec) | setNumber (exec) | work($WORK_N) (exec) | work($WORK_N) (total) | work() result | code bytes |"
echo "|---|---|---|---|---|---|---|---|---|"
for row in "$s" "$v"; do
  IFS='|' read -r l ft fl st add set wl wt res sz <<<"$row"
  echo "| $l | $ft / $fl | $st | $add | $set | $wl | $wt | $res | $sz |"
done
IFS='|' read -r _ _ _ _ _ _ swl _ sres _ <<<"$s"
IFS='|' read -r _ _ _ _ _ _ vwl _ vres _ <<<"$v"
echo
if [ "$sres" = "$vres" ]; then
  echo "Both contracts returned the same work() result ($sres)."
else
  echo "WARNING: work() results differ (Stylus $sres, Solidity $vres), so the comparison is invalid."
  exit 1
fi
echo "work($WORK_N) execution gas: Solidity $vwl, Stylus $swl."
echo "Solidity deployment gas: $SOL_DEPLOY_GAS (Stylus deployment includes activation and is not compared)."
