// A review before wave 5b: THE POSITION INDEX IS SHARED BY THREE LANES ON 4663 (positions, stocks, imdfeeds).
// PROPERTY: concurrent callers share ONE refresh (single-flight): each range is read once, every caller gets the same complete index,
// the cursor never goes back, and no caller resets or writes the index file across another's refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BigNumber, utils } from "ethers";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "keeper-w5k-index-"));
const { loadIndex } = await import("../lib/positions.mjs");
const { readStateOr } = await import("../lib/state.mjs");
const { rng } = await import("./lib/rh-world.mjs");

const LEDGER = "0x00000000000000000000000000000000000000Ed";
const OPENED = utils.id("Opened(uint256,bytes32,address,uint256)");
const ILK = utils.formatBytes32String("ETH");

function world(seed) {
  const r = rng(seed);
  const head = 50_000;
  const opened = [...Array(20)].map((_, i) => ({ id: i + 1, block: 1 + Math.floor(r() * (head - 10)) }));
  const reads = [];
  const provider = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }) => {
      reads.push([fromBlock, toBlock]);
      await new Promise((res) => setTimeout(res, Math.floor(r() * 5))); // the lanes interleave here
      return opened.filter((o) => o.block >= fromBlock && o.block <= toBlock).map((o) => ({ topics: [OPENED, utils.hexZeroPad(utils.hexlify(o.id), 32), ILK], blockNumber: o.block }));
    },
  };
  const book = {
    record: {}, ilks: [{ id: ILK, name: "ETH" }],
    ledger: { address: LEDGER, ilkState: async () => ({ collateral: BigNumber.from(opened.length) }), position: async () => ({ collateral: BigNumber.from(1) }) },
  };
  const ctx = { book, cfg: { LOGS: { chunk: 9000, lag: 3 }, LEDGER_FROM_BLOCK: 1 }, provider, log() {}, alerts: { raise: async () => {}, settle: async () => {} } };
  return { ctx, reads, opened };
}

test("three lanes loading the index at once share one refresh; each range read once; all see the full index (30 seeds)", async () => {
  for (let seed = 1; seed <= 30; seed++) {
    rmSync(process.env.STATE_DIR, { recursive: true, force: true });
    const { ctx, reads, opened } = world(seed);
    const all = await Promise.all([loadIndex(ctx), loadIndex(ctx), loadIndex(ctx)]);
    for (const idx of all) assert.equal(idx[ILK].length, opened.length, `seed ${seed}`);
    const keys = reads.map((x) => x.join("-"));
    assert.equal(new Set(keys).size, keys.length, `seed ${seed}: a range was read twice (${keys.length} reads)`);
    const s = readStateOr(`index-${LEDGER.toLowerCase()}.json`, null);
    assert.equal(s.next, 50_000 - 3 + 1, `seed ${seed}: the cursor`);
  }
});
