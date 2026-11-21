// Bridge, the wave-5b contracts snapshot: a hold is only a DELAY (a held payload QUEUES for D
// when its hold ends), held/unvoided payloads always queue, and the incident rule is the VOID SWEEP before any reopening. Properties:
//   (a) no alert offers hold as the equal of voidPayload: void is the response, hold only delays;
//   (b) the forged and breaker alerts name the void sweep before UNPAUSE / any reopening;
//   (c) the bulk cutoff named for a forged Queued is at or before the FIRST forged pending Queued of the path;
//   (d) an honest held message that arrives as a Queued after its hold is matched (no forged/held/stuck critical) and auto-claimed after D.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-br3-"));
const { matchDirection, verifiedAlerts, emptySide, payloadHashOf } = await import("../lib/bridge.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const W = await import("./lib/bridge-world.mjs");
const E18 = BigNumber.from(10).pow(18);
const lc = (a) => String(a).toLowerCase();
const PEER = "0x00000000000000000000000000000000000B0001";

test("(a) a forged packet waiting at the endpoint: void is the response, hold is said to only delay", async () => {
  const src = { ...emptySide(1), throughBlock: 100 }, dst = emptySide(1);
  const hash = lc(utils.hexZeroPad("0x77", 32));
  dst.verified[`${EID[1]}:5`] = { [hash]: { sender: lc(utils.hexZeroPad(PEER, 32)), block: 1, time: 0, tx: "0x1", srcBound: 50 } };
  const out = await verifiedAlerts({ src, dst, srcEid: EID[1], dstEid: EID[4663], srcBridge: PEER, now: 10, srcName: "mainnet", dstName: "4663", readStored: async () => hash });
  const msg = out.find((a) => a.key === "bridge-verified-forged-4663-5").msg;
  assert.match(msg, new RegExp(`voidPayload\\(${hash}\\) NOW`));
  assert.doesNotMatch(msg, /hold\(\d+, \d+\) or voidPayload/, "hold offered as the equal of void");
  assert.match(msg, /hold only DELAYS/);
  assert.match(msg, /VOID SWEEP before ANY reopening/);
});

test("(b)+(c) forged Queued alerts: the cutoff is the FIRST forged Queued's time, and the sweep is named", () => {
  const src = { ...emptySide(1), throughBlock: 1000 }, dst = emptySide(1);
  for (const [n, t] of [[7, 200], [6, 100], [8, 300]]) dst.queue[`${EID[1]}:${n}`] = { guid: lc(utils.hexZeroPad(utils.hexlify(n), 32)), to: lc(utils.hexZeroPad("0x99", 20)), amount: E18.toString(), queuedAt: t, time: t, claimableAt: t + 43200, state: "pending", tx: "0x1", srcBound: 10 };
  const { alerts } = matchDirection({ src, dst, srcEid: EID[1], dstEid: EID[4663], now: 400, srcName: "mainnet", dstName: "4663" });
  const q = alerts.filter((a) => a.key.startsWith("bridge-queued-forged-4663-"));
  assert.equal(q.length, 3);
  for (const a of q) {
    assert.match(a.msg, /tighten\(30101, <cap>, <delay>, <breaker>, 100\)/, `${a.key}: cutoff not the first forged Queued`);
    assert.match(a.msg, /VOID SWEEP before ANY reopening/);
  }
});

test("(b) the breaker and forged-Received procedures put the void sweep before UNPAUSE", async () => {
  const src = { ...emptySide(1), throughBlock: 1000 }, dst = emptySide(1);
  dst.received[`${EID[1]}:9`] = { guid: "0x1", to: "0x2", amount: E18.toString(), block: 1, time: 0, tx: "0x3", srcBound: 10 };
  const { alerts } = matchDirection({ src, dst, srcEid: EID[1], dstEid: EID[4663], now: 10, srcName: "mainnet", dstName: "4663" });
  assert.match(alerts.find((a) => a.key === "bridge-forged-4663-9").msg, /VOID SWEEP before ANY reopening/);
  const text = (await import("node:fs")).readFileSync(new URL("../lib/bridge.mjs", import.meta.url), "utf8");
  const i = text.indexOf("Procedure: pause(eid) at once");
  assert.ok(i > 0 && text.indexOf("VOID SWEEP", i) < text.indexOf("BATCH[RESET_BREAKER, UNPAUSE]", i), "the breaker procedure sweeps before UNPAUSE");
});

test("(d) an honest held message arrives as a Queued when its hold ends: matched, never forged/held/stuck, auto-claimed after D", async () => {
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
  const w = W.makeBridgeWorld({ seed: 12, home: 4663, delay: 600 });
  const rec = W.honest(w, 1, 1, W.T0 + 100, 1200, E18.mul(100), { queue: true }); // held 20 min, then queued for D
  W.pushLog(w.home, w.home.headAt(W.T0 + 300), w.home.bridge, W.BRIDGE_IFACE, "HoldPlaced", [EID[1], utils.hexZeroPad(PEER, 32), 1, payloadHashOf({ guid: rec.claim.guid, to: rec.claim.to, amount: E18.mul(100) }), W.T0 + 1300]);
  const raised = [], sends = [];
  const ctx = W.bridgeCtx(w, raised, { execute: true, settleSends: async () => {}, actHook: async (label) => { sends.push({ label, t: w.t }); W.settleClaim(w, 4663, rec.claim, 2); return { hash: "0x01" }; } });
  const { runBridge } = await import("../lib/bridge.mjs");
  for (let p = W.T0 + 60; p <= W.T0 + 3600; p += 120) { if (w.t < p) w.t = p; await runBridge(ctx); }
  // While the Safe holds it, bridge-held is critical by design; once it has QUEUED it is a claim like any other.
  const bad = raised.filter((a) => a.level === "critical" && (/^bridge-(forged|queued-forged|stuck)-/.test(a.key) || (a.key.startsWith("bridge-held-") && a.t > rec.claim.queuedReal + 240)));
  assert.deepEqual(bad.map((a) => `${a.key}: ${a.msg.slice(0, 160)}`), [], "an honest held message alerted as a forgery or stuck");
  assert.equal(sends.length, 1, "claimed once");
  assert.ok(sends[0].t >= rec.claim.queuedReal + 600, "not before D");
});
