// Auto-claim: only a chain's own keeper can claim there, so transfers queued on MAINNET need the mainnet keeper's bridge
// loop. PROPERTY: a mainnet deployment record that names a bridge with BRIDGE_WATCH off is never silent (critical at startup), and
// the example config runs the mainnet watcher.
import { test } from "node:test";
import assert from "node:assert/strict";

test("mainnet claims are never silently unclaimed: a record with a bridge and BRIDGE_WATCH off warns at startup; the example config watches", async () => {
  const { bridgeWatchOff } = await import("../lib/bridge.mjs");
  const bridge = "0x00000000000000000000000000000000000B0001";
  assert.match(bridgeWatchOff({ CHAIN_ID: 1 }, { bridge }) ?? "", /BRIDGE_WATCH/);
  assert.match(bridgeWatchOff({ CHAIN_ID: 1, BRIDGE_WATCH: { enabled: false } }, { bridge }) ?? "", /claim/);
  assert.equal(bridgeWatchOff({ CHAIN_ID: 1, BRIDGE_WATCH: { enabled: true } }, { bridge }), null);
  assert.equal(bridgeWatchOff({ CHAIN_ID: 1 }, { bridge: "0x0000000000000000000000000000000000000000" }), null, "no bridge wired yet: nothing to watch");
  assert.equal(bridgeWatchOff({ CHAIN_ID: 1 }, {}), null);
  assert.equal(bridgeWatchOff({ CHAIN_ID: 4663 }, { bridge }), null, "the 4663 keeper always runs the bridge loop");
  const cfg = (await import("../config.example.js")).default;
  assert.equal(cfg.BRIDGE_WATCH?.enabled, true, "the example config runs the mainnet bridge watcher");
  assert.ok(cfg.PEERS?.[4663]?.READ_RPC_URLS?.length, "...with a 4663 read RPC for the peer");
});
