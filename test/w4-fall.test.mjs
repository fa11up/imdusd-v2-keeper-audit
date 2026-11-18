// PROPERTY (audit wave 4, Q4): the keeper measures a fall against exactly the price the Pricer measures loans at. For every state of
// the legs (fresh or stale, converged or clamped, within skew or apart, proven or not) the keeper buys a fall iff the live pool leg is
// at least the trigger below Pricer.quote().low (in the Pricer's unit); unpriced, iff the pool is that far below the stored median.
// Seeded fuzz; test/lib/pricer-model.mjs (a port of Pricer.quote) is the oracle, and the composite unit (x ETH/USD x rate) varies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber } from "ethers";
import { fallDecision } from "../lib/feeds.mjs";
import { pricerLow } from "./lib/pricer-model.mjs";

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

test("property Q4: a fall is bought iff the pool is the trigger below what the Pricer measures loans at (seeded fuzz, 5000 states)", () => {
  const r = rng(0x44);
  const failures = [];
  for (let i = 0; i < 5000 && failures.length < 6; i++) {
    const m = 1_000_000n + BigInt(Math.floor(r() * 9_000_000)); // raw legs, wei ETH per IMD (scaled)
    const s = r() < 0.1 ? 0n + 1n : (m * BigInt(Math.floor(60 + r() * 80))) / 100n;
    const pool = (m * BigInt(Math.floor(40 + r() * 100))) / 100n;
    const k = BigInt(1 + Math.floor(r() * 5000)); // ETH/USD x rate: the composite's unit
    const flags = { skewBps: [300, 500, 1000][Math.floor(r() * 3)], medianFresh: r() < 0.85, spotFresh: r() < 0.7, mConverged: r() < 0.6, sConverged: r() < 0.9, proven: true };
    // A clamped median (not converged) holds a level nobody attested: its attested target is anywhere around it.
    const attested = flags.mConverged ? m : (m * BigInt(Math.floor(50 + r() * 100))) / 100n;
    const q = pricerLow({ m: m * k, s: s * k, attested: attested * k, ...flags });
    const triggerBps = 500;
    const d = fallDecision({
      median: m, spot: s, pool, quote: { priced: q.priced, low: BigNumber.from(q.low.toString()) }, live: BigNumber.from((pool * k).toString()),
      skewBps: flags.skewBps, triggerBps, atRisk: true, lastBuyAt: 0, now: 1, minGapSeconds: 0, hadOpenOrder: false,
    });
    const ref = q.priced ? q.low : m * k;
    const p = pool * k;
    const want = p * 10_000n <= ref * BigInt(10_000 - triggerBps);
    if ((d.kind === "buy") !== want) failures.push(`m ${m} s ${s} pool ${pool} ${JSON.stringify(flags)}: Pricer low ${q.priced ? q.low / k : "unpriced"}, keeper ${d.kind}, want ${want ? "buy" : "no buy"}`);
  }
  assert.deepEqual(failures, []);
});

// Fixed before audit wave 5: the oracle above must be the Pricer's CURRENT twin rule (the contracts' src/Pricer.sol), not
// the old max(median, spot): legs apart with a fresh proven spot -> low = m > s ? max(s, min(m, attestedMedian)) : s.
test("the Pricer model is the current twin rule: a median clamped above its attested value counts only at what was attested", () => {
  const legsApart = { skewBps: 500, mConverged: false };
  // A real fall: the proven spot shows it, the median attested it, but the leaf is clamped above (holds a level nobody attested).
  assert.equal(pricerLow({ m: 1000n, s: 700n, attested: 750n, ...legsApart }).low, 750n, "max(s, min(m, attested)) = 750, not the clamped 1000");
  assert.equal(pricerLow({ m: 1000n, s: 700n, attested: 600n, ...legsApart }).low, 700n, "a pushed spot cannot go under what the median attested; the spot is the floor");
  assert.equal(pricerLow({ m: 1000n, s: 700n, attested: 1200n, ...legsApart }).low, 1000n, "attested above the median: the median");
  assert.equal(pricerLow({ m: 700n, s: 1000n, attested: 700n, ...legsApart }).low, 1000n, "median under the spot: the spot");
  assert.equal(pricerLow({ m: 1000n, s: 700n, ...legsApart }).low, 1000n, "no attested given: the median is its own target (unclamped)");
});
