// PROPERTY (audit wave 4, C7): an hour of the depth round is marked done only once its samples landed, or a successful read showed
// no sample could land; a failed read leaves the hour open for the next pass. And a failed read still pokes, but a poke that already
// landed alone this hour is not sent again on every later failed read (bounded gas).
//
// Seeded fuzz over the passes of one hour: the read (simulation, then ImdDepth's storage) failing or not, samplers refusing or not,
// the batch and the poke landing or refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w4-depth-"));
const { readState, statePath, writeState } = await import("../lib/state.mjs");
const { runDepth } = await import("../lib/depth.mjs");

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function world(r, now) {
  const w = { sent: [], readFails: false, lowFails: false, samplerOk: true, batchOk: true, pokeOk: true };
  const contract = (name, fn) => {
    const c = {
      address: `0x${name}`, interface: { encodeFunctionData: (f) => f },
      callStatic: { [fn]: async () => { if (fn === "poke" && !w.pokeOk) throw Object.assign(new Error("refused"), { reason: "refused" }); } },
      [fn]: async () => {
        if (fn === "aggregate3" && !w.batchOk) throw new Error("estimate reverted");
        w.sent.push(name);
        return { hash: "0x1", wait: async () => ({ blockNumber: 1, gasUsed: 1 }) };
      },
    };
    c.connect = () => c;
    return c;
  };
  const multicall = contract("batch", "aggregate3");
  multicall.callStatic.aggregate3 = async (calls) => {
    if (w.readFails) throw new Error("read RPCs disagree");
    return calls.map((c) => (c.callData === "sample" ? { success: w.samplerOk, returnData: "0x" } : { success: true, returnData: "0x01" }));
  };
  const provider = {
    getBlock: async () => ({ number: 1, timestamp: now, baseFeePerGas: 1n }),
    getStorageAt: async () => { if (w.lowFails) throw new Error("storage read timed out"); return "0x0"; },
    getGasPrice: async () => BigNumber.from(1), getBalance: async () => BigNumber.from(10).pow(18), unpin() {},
  };
  const imdDepth = { ...contract("poke", "poke"), lowOf: async () => ({ day: Math.floor(now / 86_400) - (r() < 0.5 ? 1 : 0) }) };
  imdDepth.connect = () => imdDepth;
  w.ctx = { execute: true, log() {}, provider, multicall, cfg: {}, signer: { provider, address: "0xk" }, book: { imdDepth, samplers: [contract("sampler", "sample")] }, alerts: { raise: async () => {} } };
  return w;
}

test("property C7: an hour is done only after its samples landed or a good read found none; a failed read retries (seeded fuzz, 150 hours)", async () => {
  const failures = [];
  const r = rng(0xc7);
  for (let h = 0; h < 150 && failures.length < 6; h++) {
    rmSync(statePath("depth.json"), { force: true });
    const now = 20_000 * 86_400 + Math.floor(r() * 24) * 3600 + 3000;
    writeState("depth.json", { hour: Math.floor(now / 3600), at: now - 1, done: false });
    const w = world(r, now);
    let samplesLanded = false, emptyGoodRead = false, pokesAfterFailedRead = 0;
    for (let pass = 0; pass < 6; pass++) {
      w.readFails = r() < 0.4;
      w.lowFails = !w.readFails && r() < 0.15;
      w.samplerOk = r() < 0.7;
      w.batchOk = r() < 0.8;
      w.pokeOk = r() < 0.8;
      const sentBefore = w.sent.length;
      await runDepth(w.ctx);
      const sentNow = w.sent.slice(sentBefore);
      if (sentNow.includes("batch")) samplesLanded = true;
      if (!w.readFails && !w.lowFails && !w.samplerOk) emptyGoodRead = true;
      if (w.readFails && sentNow.includes("poke")) pokesAfterFailedRead += 1;
      if (readState("depth.json").done && !samplesLanded && !emptyGoodRead) {
        failures.push(`hour ${h} pass ${pass}: done with no sample landed and no good read (read failed ${w.readFails}, low failed ${w.lowFails})`);
        break;
      }
      if (readState("depth.json").done) break;
    }
    if (pokesAfterFailedRead > 1) failures.push(`hour ${h}: ${pokesAfterFailedRead} pokes sent alone on failed reads`);
  }
  assert.deepEqual(failures, []);
});
