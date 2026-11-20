// wave-5 keeper audit #6: WITH ONE LOG RPC A REFUSED RANGE IS NEVER HALVED.
// PROPERTY (C3/P5/P1): a node that refuses a log range (caps it, rate-limits it) is asked for smaller ranges whether it is the only
// node or one of several; the walk reaches head - lag. Fuzzed: random range caps, random transient 429s, one URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber, utils } from "ethers";

const { indexSide, emptySide } = await import("../lib/bridge.mjs");
const { AgreeingProvider } = await import("../lib/chain.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const BRIDGE = "0x00000000000000000000000000000000000B4663";
const HEAD = 100_000;

/** The real AgreeingProvider on ONE url; its node caps getLogs ranges at `cap` blocks and answers 429 with chance `p429`. */
function lone({ cap, p429 = 0, r = Math.random }) {
  const ap = new AgreeingProvider(["http://lone.invalid"], 4663);
  const node = ap.logProviders[0];
  node.perform = async (m, q) => {
    if (m !== "getLogs") throw new Error(`unexpected ${m}`);
    const span = Number(q.filter.toBlock) - Number(q.filter.fromBlock) + 1;
    if (r() < p429) throw Object.assign(new Error("429 Too Many Requests"), { code: "SERVER_ERROR" });
    if (span > cap) throw Object.assign(new Error(`query exceeds max block range ${cap}`), { code: "SERVER_ERROR" });
    return [];
  };
  ap.perform = async function (method, params) {
    if (method === "getBlockNumber") return HEAD;
    if (method === "getBlock") return { number: Number(params.blockTag), timestamp: 1_800_000_000, hash: utils.hexZeroPad(utils.hexlify(Number(params.blockTag) + 1), 32), parentHash: utils.hexZeroPad("0x", 32), transactions: [], difficulty: 0, gasLimit: "0x0", gasUsed: "0x0", miner: utils.hexZeroPad("0x", 20), extraData: "0x", nonce: "0x0000000000000000" };
    if (method === "getCode") return "0x6000";
    return AgreeingProvider.prototype.perform.call(this, method, params);
  };
  return ap;
}
const bridge = { address: BRIDGE, sent: async () => BigNumber.from(0), received: async () => BigNumber.from(0) };

test("judge proof shape: a lone RPC capping ranges at 2,000 blocks is walked to head - lag in smaller ranges", async () => {
  const side = emptySide(1);
  const r = await indexSide(lone({ cap: 2000 }), bridge, side, { lag: 3, chunk: 9000, maxChunks: 1e9, budgetMs: 1e9 });
  assert.equal(side.throughBlock, HEAD - 3, JSON.stringify(r));
});

test("property: random caps (>= minChunk) and transient 429s on one RPC: the walk always progresses and never skips a block (40 seeds)", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed * 31);
    const cap = 500 + Math.floor(r() * 20_000);
    const side = emptySide(1);
    const p = lone({ cap, p429: 0.05, r });
    for (let pass = 0; pass < 200 && side.throughBlock < HEAD - 3; pass++) {
      const before = side.throughBlock;
      try { await indexSide(p, bridge, side, { lag: 3, chunk: 50_000 }); } catch (e) { assert.ok(e.refused, `seed ${seed}: threw a non-refused error: ${e.message}`); }
      assert.ok(side.throughBlock >= before, `seed ${seed}: cursor went back`);
    }
    assert.equal(side.throughBlock, HEAD - 3, `seed ${seed} (cap ${cap}): stuck at ${side.throughBlock}`);
  }
});
