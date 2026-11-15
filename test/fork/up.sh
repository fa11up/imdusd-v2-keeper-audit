#!/usr/bin/env bash
# Deploy the real v2 beta onto a local anvil fork of mainnet, through the contracts' own launch.sh (FORK=1), and leave anvil
# running for test/fork/e2e.mjs. Nothing reaches mainnet: launch.sh refuses a non-local RPC in FORK=1. Keys are anvil's.
#   V2=/path/to/imdusd-v2-checkout FORK_URL=<archive rpc> PORT=8557 test/fork/up.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "${V2:-}" ]; then
  echo "usage: V2=/path/to/imdusd-v2-checkout [FORK_URL=<archive rpc>] [PORT=8557] test/fork/up.sh" >&2
  echo "  V2 must be a contracts checkout with deploy/mainnet/launch.sh" >&2
  exit 2
fi
[ -x "$V2/deploy/mainnet/launch.sh" ] || { echo "up.sh: $V2/deploy/mainnet/launch.sh not found" >&2; exit 2; }
FORK_URL=${FORK_URL:-https://eth.drpc.org}
PORT=${PORT:-8557}; RPC=http://127.0.0.1:$PORT
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
WORK=$HERE/.work; mkdir -p "$WORK"
FRESH=0
if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  FRESH=1
  nohup anvil --fork-url "$FORK_URL" ${FORK_BLOCK:+--fork-block-number $FORK_BLOCK} --port "$PORT" --silent > "$WORK/anvil.log" 2>&1 &
  echo $! > "$WORK/anvil.pid"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
fi
cd "$V2"
ENVF=$WORK/launch.env
printf 'PRIVATE_KEY=%s\nDEPLOYER=%s\nMAINNET_RPC_URL=%s\n' "$K0" "$A0" "$RPC" > "$ENVF"
# A fresh fork starts a fresh launch; a fork still running keeps its record, so `go` resumes (the free RPC behind anvil drops out).
[ "$FRESH" = 0 ] || rm -f deploy/mainnet/out/rehearsal/beta.json deploy/mainnet/out/rehearsal/beta-gas.json
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
for try in 1 2 3 4 5 6; do   # the free RPC behind anvil fails simulations now and then (FatalExternalError); landed stages are skipped
  FORK=1 LAUNCH_ENV="$ENVF" CONFIG=beta deploy/mainnet/launch.sh go < <(yes SEND) > "$WORK/launch.log" 2>&1 && break
  [ "$try" = 6 ] && { tail -5 "$WORK/launch.log"; exit 1; }
  echo "launch attempt $try stopped: $(grep -m1 -E 'launch:' "$WORK/launch.log" | cut -c1-120)"
  sleep 20
done
cp deploy/mainnet/out/rehearsal/beta.json "$WORK/record.json"
git -C "$V2" rev-parse --short HEAD > "$WORK/v2-commit"
echo "beta deployed on $RPC from $(cat "$WORK/v2-commit"); record $WORK/record.json"
