// RateFeed pokes (src/feeds/RateFeed.sol in the contracts). A yield-bearing share (each StockVault, the Steakhouse USDG vault behind S-USDG) is
// priced at min(live rate, max(checkpoint grown at the capped rate since the checkpoint, highest rate accepted)); `poke()` moves the
// checkpoint up to that capped rate. Falls need no poke (the view takes a fall at once), so only RISES are poked: when the capped rate
// is RATES.minMoveBps above the checkpoint, or the checkpoint is RATES.maxAgeHours old and the rate has risen at all. Routine tier:
// nothing is priced wrong meanwhile, a stale checkpoint only makes the next harvest and rise judged from an older base.
// Since wave 1 `poke()` REVERTS when its source cannot be read (it was a silent no-op), so the simulation in act() is honest and no
// fixed gas limit is needed (the v1 keeper's Robinhood keeper needed one).
import { BigNumber, constants } from "ethers";
import { act, head } from "./act.mjs";

/** Pure: { due, moveBps, age } for one RateFeed. */
export function rateDue({ now, rate, checkpointRate, checkpointAt, minMoveBps = 5, maxAgeSeconds = 86_400 }) {
  const r = BigNumber.from(rate), ck = BigNumber.from(checkpointRate);
  const age = now - Number(checkpointAt);
  if (r.isZero() || ck.isZero() || r.lte(ck)) return { due: false, moveBps: 0, age };
  const moveBps = r.sub(ck).mul(1_000_000).div(ck).toNumber() / 100;
  return { due: moveBps >= minMoveBps || age >= maxAgeSeconds, moveBps, age };
}

export async function runRates(ctx) {
  const { book, cfg, log, provider } = ctx;
  if (!book.rates?.length) return log("rates   no RateFeeds in this deployment");
  const { now } = await head(provider);
  const minMoveBps = cfg.RATES?.minMoveBps ?? 5;
  const maxAgeSeconds = (cfg.RATES?.maxAgeHours ?? 24) * 3600;
  const raised = [];
  let due = 0;
  for (const { feed, ilks } of book.rates) {
    const [rate, checkpointRate, checkpointAt] = await Promise.all([feed.rate(), feed.checkpointRate(), feed.checkpointAt()]);
    if (BigNumber.from(rate).isZero()) {
      raised.push({ level: "warn", key: `rates-unreadable-${feed.address.toLowerCase()}`, msg: `RateFeed ${feed.address} (${ilks.join(",")}) reads 0: its source does not answer, the type is unpriced` });
      continue;
    }
    // An UNCAPPED RateFeed (wave-5b contracts snapshot: maxGrowthPerSecond == type(uint256).max, the live rate) has no checkpoint that
    // matters: a poke only costs gas (internal review after wave 5). Read once; a feed without the getter (older build) is treated as capped.
    if (feed.uncapped === undefined) feed.uncapped = typeof feed.maxGrowthPerSecond === "function" ? await feed.maxGrowthPerSecond().then((g) => constants.MaxUint256.eq(g)).catch(() => false) : false;
    if (feed.uncapped) continue;
    const d = rateDue({ now, rate, checkpointRate, checkpointAt, minMoveBps, maxAgeSeconds });
    if (!d.due) continue;
    due += 1;
    await act(ctx, `rate poke ${ilks.join(",")} (+${d.moveBps} bps over ${Math.round(d.age / 3600)} h)`, feed, "poke", [], { tier: "routine" });
  }
  log(`rates   ${book.rates.length} RateFeeds, ${due} poked`);
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("rates-", new Set(raised.map((a) => a.key)));
}
