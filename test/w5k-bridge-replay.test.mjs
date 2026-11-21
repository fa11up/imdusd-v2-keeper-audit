// A review before wave 5b: a forged REPLAY of an honest (guid, message) at another nonce has the honest message's payload hash,
// and a void is by hash on every path and nonce: voiding it refuses the honest transfer too. PROPERTY: the watcher never tells the Safe
// to voidPayload a hash an honest Sent has (at any nonce); for a replay it gives the nonce-scoped response (hold the forged nonce, then
// RELEASE it naming a hash nothing has, within 24 h); a forgery whose hash no Sent has still gets voidPayload. Also the held case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, utils } from "ethers";

const { verifiedAlerts, matchDirection, emptySide, payloadHashOf } = await import("../lib/bridge.mjs");
const { EID } = await import("../lib/robinhood.mjs");
const { rng } = await import("./lib/rh-world.mjs");
const E18 = BigNumber.from(10).pow(18);
const lc = (a) => String(a).toLowerCase();
const PEER = "0x00000000000000000000000000000000000B0001";
const sender = lc(utils.hexZeroPad(PEER, 32));
const sentAt = (n) => ({ guid: lc(utils.keccak256(utils.toUtf8Bytes(`g${n}`))), to: lc(utils.hexZeroPad(utils.hexlify(0x1000 + n), 32)), amount: E18.mul(n).toString(), block: 1, time: 0, tx: "0x1" });

test("property: a verified hash that an honest Sent has at another nonce is a REPLAY (no void advice); one no Sent has is voided (300 seeds)", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const src = { ...emptySide(1), throughBlock: 1000 }, dst = emptySide(1);
    const k = 2 + Math.floor(r() * 6);
    for (let n = 1; n <= k; n++) src.sent[`${EID[4663]}:${n}`] = sentAt(n);
    const n = k + 1 + Math.floor(r() * 3); // a nonce the source has not sent yet
    const replay = r() < 0.5;
    const hash = replay ? lc(payloadHashOf(src.sent[`${EID[4663]}:${1 + Math.floor(r() * k)}`])) : lc(utils.hexZeroPad(utils.hexlify(seed), 32));
    dst.verified[`${EID[1]}:${n}`] = { [hash]: { sender, block: 1, time: 0, tx: "0x2", srcBound: 10 } };
    const out = await verifiedAlerts({ src, dst, srcEid: EID[1], dstEid: EID[4663], srcBridge: PEER, now: 10, srcName: "mainnet", dstName: "4663", readStored: async () => hash });
    const voidAdvice = out.filter((a) => new RegExp(`voidPayload\\(${hash}\\) (NOW|and)`).test(a.msg));
    if (replay) {
      assert.deepEqual(voidAdvice.map((a) => a.key), [], `seed ${seed}: told to void a hash an honest Sent has`);
      const a = out.find((x) => x.key === `bridge-verified-replay-4663-${n}`);
      assert.ok(a && a.level === "critical" && /hold\(30101, \d+\) NOW, then RELEASE/.test(a.msg), `seed ${seed}: no replay response`);
    } else assert.equal(voidAdvice.length, 1, `seed ${seed}: a plain forgery is not voided`);
  }
});

test("a held REPLAY is answered by RELEASE of the nonce, never a void", () => {
  const src = { ...emptySide(1), throughBlock: 1000 }, dst = emptySide(1);
  src.sent[`${EID[4663]}:3`] = sentAt(3);
  const h = lc(payloadHashOf(src.sent[`${EID[4663]}:3`]));
  dst.holds[`${EID[1]}:9`] = { payloadHash: h, until: 2_000_000_000, released: false };
  const { alerts } = matchDirection({ src, dst, srcEid: EID[1], dstEid: EID[4663], now: 10, srcName: "mainnet", dstName: "4663" });
  const a = alerts.find((x) => x.key === "bridge-held-4663-9");
  assert.match(a.msg, /REPLAY/);
  assert.match(a.msg, /Do NOT void/);
  assert.doesNotMatch(a.msg, /voidPayload\(/);
});

// ---- the wave-5b contracts snapshot: RELEASE(0) = DROP, the sweep per nonce, SET_BRIDGE in the reopening list,
//      inbound messages queue (and claims revert in mint) until imdUSD.bridge() names the bridge.
test("the final rule: replay = hold + RELEASE(eid, nonce, 0), no second RELEASE; the sweep per nonce; SET_BRIDGE among the reopenings", async () => {
  const src = { ...emptySide(1), throughBlock: 1000 }, dst = emptySide(1);
  src.sent[`${EID[4663]}:3`] = sentAt(3);
  const hash = lc(payloadHashOf(src.sent[`${EID[4663]}:3`]));
  dst.verified[`${EID[1]}:7`] = { [hash]: { sender, block: 1, time: 0, tx: "0x2", srcBound: 10 } };
  const out = await verifiedAlerts({ src, dst, srcEid: EID[1], dstEid: EID[4663], srcBridge: PEER, now: 10, srcName: "mainnet", dstName: "4663", readStored: async () => hash });
  const a = out.find((x) => x.key === "bridge-verified-replay-4663-7");
  assert.match(a.msg, /RELEASE\(30101, 7, 0\), a DROP/);
  assert.doesNotMatch(a.msg, /second RELEASE/);
  const forged = await verifiedAlerts({ src, dst: { ...emptySide(1), verified: { [`${EID[1]}:8`]: { ["0x" + "ab".repeat(32)]: { sender, block: 1, time: 0, tx: "0x3", srcBound: 10 } } } }, srcEid: EID[1], dstEid: EID[4663], srcBridge: PEER, now: 10, srcName: "mainnet", dstName: "4663", readStored: async () => "0x" + "ab".repeat(32) });
  assert.match(forged[0].msg, /VOID SWEEP before ANY reopening \(SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap\), PER NONCE/);
  assert.match(forged[0].msg, /hold \+ RELEASE\(eid, nonce, 0\)/);
});

test("before SET_BRIDGE honest messages queue: no forged/stuck alarm, no claim sent (info bridge-not-wired); claimed once imdUSD.bridge() names the bridge", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-wire-"));
  const W = await import("./lib/bridge-world.mjs");
  const { runBridge } = await import("../lib/bridge.mjs");
  const w = W.makeBridgeWorld({ seed: 21, home: 4663, delay: 600 });
  const rec = W.honest(w, 1, 1, W.T0 + 100, 200, E18.mul(100), { queue: true });
  let wired = "0x0000000000000000000000000000000000000000";
  const raised = [], sends = [];
  const ctx = W.bridgeCtx(w, raised, { execute: true, settleSends: async () => {}, actHook: async (label) => { sends.push(w.t); W.settleClaim(w, 4663, rec.claim, 2); return { hash: "0x01" }; } });
  ctx.book.usd = { bridge: async () => wired };
  for (let p = W.T0 + 60; p <= W.T0 + 3600; p += 120) { if (w.t < p) w.t = p; await runBridge(ctx); }
  assert.deepEqual(sends, [], "a claim was sent before SET_BRIDGE");
  assert.ok(raised.some((a) => a.key === "bridge-not-wired-4663" && a.level === "info"));
  assert.deepEqual(raised.filter((a) => /^bridge-(forged|queued-forged|stuck)-/.test(a.key)).map((a) => a.key), []);
  wired = w.home.bridge;
  for (let p = W.T0 + 3720; p <= W.T0 + 4200; p += 120) { if (w.t < p) w.t = p; await runBridge(ctx); }
  assert.equal(sends.length, 1, "not claimed once wired");
  rmSync(process.env.STATE_DIR, { recursive: true, force: true });
});
