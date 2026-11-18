// Fixed before audit wave 5: LOG GAPS IN THE BRIDGE WATCHER.
// PROPERTY: a log range is marked read only once its contents are proven: two reads agree AND the bridge's own cumulative counters
// (sent(), received() at the block read through) equal what the index holds, so a log RPC that answers EMPTY for a range can never
// hide a Sent (an honest transfer then looks forged) or a Received (a forgery then goes unseen). Fuzzed: an RPC that answers [] for a
// non-empty range at random (10-50% of calls), slow calls, clock skew, both homes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5-gaps-"));
const { runBridge } = await import("../lib/bridge.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { BRIDGE_IFACE, makeBridgeWorld, nameOf, randomTraffic, runPasses } = await import("./lib/bridge-world.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const BOUND = 1800;

test("a log RPC that answers empty never hides a Sent or a Received (40 seeded runs, 10-50% empty answers)", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const r = rng(seed * 104729);
    const emptyP = 0.1 + r() * 0.4;
    const skew = { 1: Math.round((r() * 2 - 1) * 1800), 4663: Math.round((r() * 2 - 1) * 1800) };
    const w = makeBridgeWorld({ seed, skew, emptyP, slowP: 0.02, home: r() < 0.5 ? 4663 : 1 });
    randomTraffic(w);
    const raised = await runPasses(w, runBridge);
    const where = `seed ${seed} (home ${w.home.id}, empty ${Math.round(emptyP * 100)}%)`;
    for (const h of w.honest) {
      const bad = raised.filter((a) => a.key === `bridge-forged-${nameOf(h.dst)}-${h.nonce}` || a.key === `bridge-stuck-${nameOf(h.src)}-${h.nonce}`);
      assert.deepEqual(bad.map((a) => a.key), [], `${where}: honest ${nameOf(h.src)}->${nameOf(h.dst)} nonce ${h.nonce} raised ${bad.map((a) => a.key)}`);
    }
    for (const f of w.forged) {
      const hit = raised.find((a) => a.key === `bridge-forged-${nameOf(f.dst)}-${f.nonce}`);
      // In watcher time, net of the injected RPC stalls (as w5-bridge-clock): seed 17 took 2,110 s raw, 88 s net, once the
      // DelaySet proof added a read per walk; the worst net delay is ~330 s before and after.
      const net = hit ? hit.t - f.tv - w.stalledBetween(f.tv, hit.t) : Infinity;
      assert.ok(hit && net <= BOUND, `${where}: forged nonce ${f.nonce} into ${nameOf(f.dst)} ${hit ? `flagged ${Math.round(hit.t - f.tv)} s late (${Math.round(net)} s net of RPC stalls)` : "never flagged"}`);
    }
    // And the index itself is complete: every event at or below a side's read-through block is in it.
    const s = readStateOr("bridge-watch.json", {});
    for (const [side, c] of [[s.home, w.home], [s.peer, w.peer]]) {
      for (const l of c.logs.filter((x) => x.address === c.bridge && x.block <= side.throughBlock)) {
        const p = l.name;
        if (p === "Sent" || p === "Received") {
          const args = BRIDGE_IFACE.parseLog(l.encoded).args;
          const key = p === "Sent" ? `${args.dstEid}:${args.nonce}` : `${args.srcEid}:${args.nonce}`;
          assert.ok((p === "Sent" ? side.sent : side.received)[key], `${where}: ${nameOf(c.id)} ${p} ${key} at block ${l.block} <= read-through ${side.throughBlock} is missing from the index`);
        }
      }
    }
  }
});

test("an RPC that answers empty EVERY time for a range holding events stops the cursor and says so; it never marks the range read", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = makeBridgeWorld({ seed: 3, home: 4663 });
  randomTraffic(w, { forgeries: false });
  const real = w.peer.provider.getLogs;
  w.peer.provider.getLogs = async (f) => ((await real(f)).length ? [] : []); // always empty: the gap is permanent
  const raised = await runPasses(w, runBridge, { horizon: 1800 });
  const s = readStateOr("bridge-watch.json", {});
  const firstSent = w.peer.logs.find((l) => l.name === "Sent" && l.address === w.peer.bridge);
  assert.ok(!firstSent || s.peer.throughBlock < firstSent.block, `the peer cursor passed block ${firstSent?.block} (now ${s.peer.throughBlock}) on empty answers`);
  assert.ok(raised.some((a) => a.key.startsWith("bridge-index-gap-")), `no gap alert: ${[...new Set(raised.map((a) => a.key))]}`);
  assert.ok(!raised.some((a) => a.key.startsWith("bridge-forged-")), "an unreadable source never makes an honest transfer forged");
});
