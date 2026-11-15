// The alerts the operator duties ask for that no other loop reads. Nothing here sends a transaction.
import { BigNumber, utils } from "ethers";
import { bucketAlerts, depthAlerts } from "./depth.mjs";
import { head } from "./act.mjs";
import { readState, writeState } from "./state.mjs";

const big = (b) => BigInt(b.toString());
/** DepthSampler.sampleAge reads uint max before its first sample. */
export const ageOf = (b) => (b.gte(BigNumber.from(2).pow(53)) ? Infinity : b.toNumber());

export async function runWatch(ctx) {
  const { book, cfg, provider, keeperAddress } = ctx;
  const raised = [];
  const raise = (level, key, msg) => raised.push({ level, key, msg });

  // Every read is pinned to the read nodes' common block: if they all stall, every loop reads an old chain and agrees with itself.
  const { now: chainNow, number } = await head(provider);
  const behind = Math.floor(Date.now() / 1000) - chainNow;
  if (behind > (cfg.READ_MAX_LAG_SECONDS ?? 180)) raise("critical", "rpc-stale", `the read RPCs' latest block ${number} is ${behind}s old: every loop is reading an old chain`);

  // Unbacked supply: any non-zero reading.
  const unbacked = await book.ledger.unbacked();
  if (!unbacked.isZero()) raise("critical", "unbacked", `Ledger.unbacked() = ${utils.formatEther(unbacked)} imdUSD: Safe acts are lowerLine, lowerUnbackedBrake, cover`);
  const inAuction = await book.liquidator.edgeInAuction();
  if (!inAuction.isZero()) raise("warn", "edge-in-auction", `edge debt under a live mark: ${utils.formatEther(inAuction)} imdUSD`);

  // A type with debt nobody can act on, and retire proposals on a priced token.
  const kind = await book.params.RETIRE_SLEEVE_TOKEN();
  const { payload, eta } = await book.params.pendingOf(kind);
  if (!eta.isZero()) {
    const [, edge, token] = utils.defaultAbiCoder.decode(["uint8", "bool", "address"], payload);
    const t = book.ilks.find((x) => x.config.token.toLowerCase() === token.toLowerCase());
    const priced = t ? (await book.pricer.quote(t.id)).priced : false;
    if (priced) raise("critical", "retire-while-priced", `RETIRE_SLEEVE_TOKEN pending for ${token} (${edge ? "edge" : "blue"}) while it is priced: the Safe must cancel`);
  }
  for (const t of book.ilks) {
    const [debt, q] = await Promise.all([book.ledger.ilkDebt(t.id), book.pricer.quote(t.id)]);
    if (!debt.isZero() && !q.priced) raise("warn", `unpriced-${t.name}`, `${t.name} carries ${utils.formatEther(debt)} imdUSD and is unpriced`);
  }

  // Depth.
  const seen = readState("watch.json", {});
  const firstSeen = seen.firstSeen ?? Date.now();
  if (!seen.firstSeen) writeState("watch.json", { ...seen, firstSeen });
  const warmedUp = Date.now() - firstSeen > 26 * 3600 * 1000;
  const samplers = await Promise.all(book.samplers.map(async (s) => ({ address: s.address, age: ageOf(await s.sampleAge()), filled: (await s.filledBuckets()).toNumber() })));
  const [low0, low1, depthIMD, { timestamp }] = await Promise.all([book.imdDepth.lowOf(0), book.imdDepth.lowOf(1), book.params.depthIMD(), provider.getBlock("latest")]);
  // A slot keeps its own day: an old day in it means no reading yet, and that is not a fall.
  const day = Math.floor(timestamp / 86_400);
  const compare = low0.day === day && low1.day === day - 1;
  const simd = book.ilks.find((t) => t.edge);
  const simdLine = simd ? big((await book.params.storedRisk(simd.id)).line) : 0n;
  for (const a of depthAlerts({ samplers, today: compare ? big(low0.usd) : 0n, yesterday: compare ? big(low1.usd) : 0n, depthIMD: big(depthIMD), simdLine, warmedUp })) raised.push(a);
  const nowHour = Math.floor(timestamp / 3600);
  for (const s of book.samplers) {
    const [side0, buckets] = await Promise.all([s.soldIsToken0(), Promise.all([...Array(24).keys()].map((i) => s.bucket(i)))]);
    const bs = buckets.map((b) => ({ hour: Number(b.hour), v: big(side0 ? b.sell0 : b.sell1) }));
    for (const a of bucketAlerts({ address: s.address, buckets: bs, nowHour })) raised.push(a);
  }

  // Keeper's own gas.
  if (keeperAddress) {
    const bal = await provider.getBalance(keeperAddress);
    const low = utils.parseEther(String(cfg.WARN_ETH ?? 0.05));
    if (bal.lt(low)) raise("warn", "keeper-eth-low", `keeper holds ${utils.formatEther(bal)} ETH`);
  }

  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("", new Set([...raised.map((a) => a.key), ...heldElsewhere()]));
  ctx.log(`watch   ${raised.length ? `${raised.length} holding: ${raised.map((a) => a.key).join(", ")}` : "clear"}`);
}

/** Keys other loops raise and clear on their own terms: the watch pass must not call them cleared. */
function heldElsewhere() {
  return Object.keys(readState("alerts.json", {})).filter((k) => /^(depth-sampler-|depth-poke-|depth-round-|index-|cannot-close-|feeds-|seats-|peg-|backstop-|allocator-|guardian-|loop-)/.test(k));
}
