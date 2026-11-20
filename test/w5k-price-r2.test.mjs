// Keeper duties for the wave-5 price fixes (the contracts' price leaves in the wave-5b contracts snapshot):
//   1. price leaves no longer widen after a silence: a median held above its last (falling) answer is walked on by one honest median
//      per epoch until it converges; a rise is never bought; never twice in one epoch.
//   2. an epoch whose range high sits above its anchor while the median is held above its falling answer: `feeds-median-held`.
//   3. PricerOracle refusing sIMD while the quote is priced: the pool within skew of the median = prove the latest block now
//      (`feeds-simd-refused`); else a rally past skew, alert only (`feeds-simd-rally`); nothing when PricerOracle is ok.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber } from "ethers";

const { walkDue, heldByFirstRelayer, priceGuards } = await import("../lib/feeds.mjs");
const { rng } = await import("./lib/rh-world.mjs");
const E18 = BigNumber.from(10).pow(18);

test("walk: once per epoch while held above a falling answer; never a rise; never with an order open (2,000 seeds)", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const stored = E18.mul(100);
    const attested = E18.mul(Math.floor(r() * 200));
    const converged = r() < 0.3;
    const epochOpenedAt = 1000 + Math.floor(r() * 3) * 3600;
    const lastWalkEpoch = r() < 0.5 ? epochOpenedAt : epochOpenedAt - 3600;
    const hadOpenOrder = r() < 0.2;
    const due = walkDue({ converged, attested, stored, epochOpenedAt, lastWalkEpoch, hadOpenOrder });
    if (due) {
      assert.ok(attested.lt(stored), `seed ${seed}: a rise was walked`);
      assert.ok(!converged && !hadOpenOrder && lastWalkEpoch !== epochOpenedAt, `seed ${seed}`);
    } else if (!converged && !hadOpenOrder && attested.lt(stored)) {
      assert.equal(lastWalkEpoch, epochOpenedAt, `seed ${seed}: a held median was not walked in a new epoch`);
    }
  }
});

test("first-relayer hold: range high above the anchor while held above a falling answer", () => {
  assert.equal(heldByFirstRelayer({ rangeHigh: 120, anchor: 100, attested: 50, stored: 96 }), true);
  assert.equal(heldByFirstRelayer({ rangeHigh: 100, anchor: 100, attested: 50, stored: 80 }), false, "an honest fall: the range high is the anchor");
  assert.equal(heldByFirstRelayer({ rangeHigh: 120, anchor: 100, attested: 120, stored: 120 }), false, "an honest rise");
});

function setup({ ok, pool, median = E18.mul(10), skew = E18.div(20), held = false }) {
  const raised = [];
  const S = {
    t: { id: "0x01", config: { token: "0x00000000000000000000000000000000000000aa" } },
    median: {
      epochRange: async () => [E18, held ? E18.mul(12) : median], epoch: async () => ({ anchor: median, openedAt: 1, allowanceBps: BigNumber.from(2000) }),
      attested: async () => (held ? E18.mul(5) : median), latestValue: async () => ({ value: median, updatedAt: 1 }),
    },
    pool: { latestValue: async () => [pool, 1] },
  };
  const ctx = { log() {}, cfg: {}, execute: false, book: { backstopOracle: { priceOf: async () => ({ low: 0, high: 0, ok }) }, params: { storedRisk: async () => ({ skew }) }, proven: [] }, alerts: { raise: async () => {} } };
  return { S, ctx, raised, raise: (level, key, msg) => raised.push({ level, key, msg }) };
}

test("PricerOracle refuses sIMD, pool within skew of the median: prove now (feeds-simd-refused); past skew: a rally, alert only", async () => {
  for (const [pool, key] of [[E18.mul(102).div(10), "feeds-simd-refused"], [E18.mul(13), "feeds-simd-rally"]]) {
    const { S, ctx, raised, raise } = setup({ ok: false, pool });
    await priceGuards(ctx, S, { priced: true }, raise, []);
    assert.deepEqual(raised.map((a) => a.key), [key]);
  }
  const { S, ctx, raised, raise } = setup({ ok: true, pool: E18.mul(13) });
  await priceGuards(ctx, S, { priced: true }, raise, []);
  assert.deepEqual(raised, [], "PricerOracle ok: nothing");
});

test("a median held by a first relayer raises feeds-median-held", async () => {
  const { S, ctx, raised, raise } = setup({ ok: true, pool: E18.mul(10), held: true });
  await priceGuards(ctx, S, { priced: true }, raise, []);
  assert.deepEqual(raised.map((a) => a.key), ["feeds-median-held"]);
});
