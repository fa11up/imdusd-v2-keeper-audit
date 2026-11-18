// The sIMD legs and NHI: the REFRESH DUTY. Fully fresh would cost 24.5 IMD/day; the protocol
// refreshes lazily, by these rules, from the keeper's own IMD:
//   1. FALLS ONLY. The price (median) answer, only on a fall of the pool below what the Pricer measures loans at, and only while a loan
//      of RISK.minDebt or more would be under mat + RISK.marginBps at the pool price. PRICE DESIGN C: sIMD's spot leg is the pool's
//      PROVEN end-of-block price (ProvenPoolPrice), kept fresh by the depth round's prove-on-drift/age (depth.mjs proveNeeded): no
//      swarm spot is bought any more.
//   2. RISES ARE NEVER PAID BY THE PROTOCOL. A flat or higher pool buys nothing, stale or not: a stale type is unpriced, borrowers buy their own.
//   3. NHI ONCE A DAY, only while sIMD debt exists.
//   4. DESIGN C: a leaf takes every answer as a TARGET and moves at most its epoch's allowance toward it (20%, 40% after a silence). A
//      fall wider than that is still bought: it lands at the band's edge, the leg reads not converged (the Pricer then lends nothing on
//      sIMD) and the next epoch's answer walks it on. The alert says how many epochs (`walking`).
//   5. The first value of a leaf is the deployment's to check (no bound on chain), so an empty leaf is never bought here.
//
// Also bought: nothing else. Answers other people bought are not relayed: a rise a stranger paid for is theirs to land.
import { BigNumber, Contract, utils } from "ethers";
import { head, reasonOf } from "./act.mjs";
import { FEED_NODE } from "./deployment.mjs";
import { buildInput, bodyOf, guardsFor, leafProblems, stepsNeeded } from "./oracle.mjs";
import { advanceOrders, buyHold, costOf, ensureAllowance, openOrders, startOrder } from "./orders.mjs";
import { plane, readLiveNhi } from "./plane.mjs";
import { proveNow } from "./depth.mjs";
import { freshIndex } from "./positions.mjs";
import { declareShape, isUnreadable, readState, readStateOr, writeState } from "./state.mjs";
import { IMD } from "./x402.mjs";

const E18 = BigNumber.from(10).pow(18);
const FILE = "feeds.json";
/** The buy gap lives here: unreadable, it is never read as "never bought" (readState throws; audit wave 4, C9). */
declareShape(FILE, (v) => (v && typeof v === "object" && !Array.isArray(v) ? null : "not an object"));
const EXTSLOAD = ["function extsload(bytes32) view returns (bytes32)"];
const V4_POOLS_SLOT = 6;
const BLOCKS_PER_HOUR = 300;

/** Pure: is this loan under mat + margin at `price` (USD per 1e18 collateral)? */
export function underMargin({ collateral, debt, price, mat, marginBps = 1000 }) {
  const value = BigNumber.from(collateral).mul(price).div(E18);
  const floor = BigNumber.from(debt).mul(mat).div(E18).mul(10_000 + marginBps).div(10_000);
  return value.lt(floor);
}

/** Pure: loans that count: at or over minDebt and under mat + margin at the pool price. */
export const loansAtRisk = (loans, { price, mat, minDebt, marginBps }) => loans.filter((l) => BigNumber.from(l.debt).gte(minDebt) && underMargin({ ...l, price, mat, marginBps }));

/**
 * Pure: the decision for the price (median) answer. A fall is measured against EXACTLY what the Pricer measures loans at
 * (audit wave 4, Q4): `quote` is Pricer.quote(sIMD) read live, `live` the type's live pool leg (Parameters' liveSpot) in the same unit
 * (USD per sIMD). The keeper never re-derives the Pricer's low from the legs: convergence, the spot's freshness and the twin rule
 * are the Pricer's to apply. While the type is unpriced (a stale median or NHI) there is no low: the pool is measured against the
 * stored median, the leg a fresh answer replaces. `median`, `spot`, `pool` are the raw legs (wei of ETH per 1e18 IMD).
 * Returns { buy, kind, why }.
 */
export function fallDecision({ median, spot, pool, quote, live, triggerBps, atRisk, lastBuyAt, now, minGapSeconds, hadOpenOrder }) {
  const m = BigNumber.from(median), s = BigNumber.from(spot);
  if (m.isZero() || s.isZero()) return { buy: false, kind: "unseeded", why: "a leg holds no value: the first value is the deployment's to buy and check" };
  const priced = Boolean(quote?.priced);
  const reference = priced ? BigNumber.from(quote.low) : m;
  const p = BigNumber.from(priced ? live ?? 0 : pool);
  if (p.isZero()) return { buy: false, kind: "no-pool", why: "the pool reads zero" };
  const at = priced ? "the Pricer's low" : "the stored median (sIMD unpriced)";
  if (p.mul(10_000).gt(reference.mul(10_000 - triggerBps))) return { buy: false, kind: "no-fall", why: `the pool is under ${triggerBps / 100}% below ${at}` };
  if (!atRisk) return { buy: false, kind: "no-risk", why: "a fall, but no loan that counts is near its limit at the pool price" };
  if (hadOpenOrder) return { buy: false, kind: "open", why: "an order for these legs is still open" };
  if (lastBuyAt && now - lastBuyAt < minGapSeconds) return { buy: false, kind: "wait", why: `bought ${now - lastBuyAt}s ago, next from ${minGapSeconds}s` };
  return { buy: true, kind: "buy", why: `a fall below ${at} with a loan at risk` };
}

/** Pure: the decision for NHI. `acceptsLive` null = the live index could not be read. */
export function nhiDecision({ value, age, refreshAfter, debt, acceptsLive, hadOpenOrder, lastBuyAt, now, minGapSeconds }) {
  if (BigNumber.from(debt).isZero()) return { buy: false, kind: "no-debt", why: "no sIMD debt" };
  if (BigNumber.from(value).isZero()) return { buy: false, kind: "unseeded", why: "the leaf holds no value: the first value is the deployment's to buy and check" };
  if (age < refreshAfter) return { buy: false, kind: "fresh", why: `${age}s old, refresh from ${refreshAfter}s` };
  if (hadOpenOrder) return { buy: false, kind: "open", why: "an order is still open" };
  if (acceptsLive === null) return { buy: false, kind: "no-read", why: "the live index cannot be read, so whether the leaf would take it is unknown" };
  if (!acceptsLive) return { buy: false, kind: "gap", why: "the leaf would refuse the live index" };
  if (lastBuyAt && now - lastBuyAt < minGapSeconds) return { buy: false, kind: "wait", why: `bought ${now - lastBuyAt}s ago, next from ${minGapSeconds}s` };
  return { buy: true, kind: "buy", why: "due, and sIMD debt exists" };
}

/** The keeper's IMD against what the next orders need. */
export function imdAlerts({ balance, warnImd, needImd, inUse }) {
  const out = [];
  if (BigNumber.from(balance).lt(utils.parseEther(String(needImd))) && inUse) out.push({ level: "critical", key: "feeds-imd-empty", msg: `keeper holds ${utils.formatEther(balance)} IMD, under one order (${needImd}): the Safe tops it up` });
  else if (BigNumber.from(balance).lt(utils.parseEther(String(warnImd)))) out.push({ level: "warn", key: "feeds-imd-low", msg: `keeper holds ${utils.formatEther(balance)} IMD, under ${warnImd}` });
  return out;
}

/** Pure: a leg held short of its last answer (design C: clamped into its epoch's band). The Pricer lends nothing on the type until it
 *  converges; the next answer in a new epoch walks it on. NHI held short also stops borrowing (its mat is one nobody attested). */
export function convergenceAlert({ role, converged, stored, attested }) {
  if (converged) return null;
  return { level: "warn", key: `feeds-not-converged-${role}`, msg: `sIMD ${role} holds ${stored}, short of its last answer ${attested}: no new sIMD debt until it converges (the next epoch's answer walks it on; liquidation runs)` };
}

/** Pure: sIMD's spot leg is the PROVEN pool price (design C), kept fresh only by the depth round's prove (depth.mjs proveNeeded:
 *  drift, refusal, or within its margin of maxAge). Borrowing needs a fresh spot, so a proof that is not renewed stops new sIMD debt
 *  silently: warn in the last half of the margin the depth round proves in (it has had its turn), critical once stale. `age` null = unread. */
export function provenSpotAlert({ stale, age, maxAge, marginSeconds = 3600 }) {
  if (age === null) return { level: "warn", key: "feeds-proven-spot-unread", msg: "the proven sIMD spot leg cannot be read: whether sIMD borrowing is open is unknown" };
  if (stale) return { level: "critical", key: "feeds-proven-spot-stale", msg: `the proven sIMD spot ${Number.isFinite(age) ? `is ${age}s old, past its ${maxAge}s life` : "has never been proved"}: no new sIMD debt until someone proves a block (the depth round should have; anyone may)` };
  // The depth round proves from `marginSeconds` before maxAge and runs hourly: warn only in the last half of that margin, once it has had its turn.
  if (age + marginSeconds / 2 >= maxAge) return { level: "warn", key: "feeds-proven-spot-ageing", msg: `the proven sIMD spot is ${age}s old, ${maxAge - age}s from stale, and the depth round has not re-proved it` };
  return null;
}

async function provenSpotAlerts(S, now, cfg) {
  try {
    const [[, at], stale, maxAge] = await Promise.all([S.spot.latestValue(), S.spot.isStale(), S.spot.maxAge()]);
    const a = provenSpotAlert({ stale, age: Number(at) === 0 ? Infinity : now - Number(at), maxAge: maxAge.toNumber(), marginSeconds: cfg?.DEPTH?.proveMarginSeconds });
    return { alerts: a ? [a] : [], unread: [] };
  } catch {
    // Unread: a standing stale/ageing alert is kept, not reported cleared (audit wave 4, P4).
    return { alerts: [provenSpotAlert({ age: null })], unread: ["feeds-proven-spot-stale", "feeds-proven-spot-ageing"] };
  }
}

/** The convergence alerts, and the roles whose legs could not be read: a standing alert for those is KEPT, never reported cleared
 *  (audit wave 4, P4: could-not-tell is not fine), and an unread alert says so. */
async function convergenceAlerts(S) {
  const out = [];
  const unread = [];
  for (const [role, leaf] of [["median", S.median], ["nhi", S.nhi]]) {
    try {
      const [converged, attested, v] = await Promise.all([leaf.converged(), leaf.attested(), leaf.latestValue()]);
      const a = convergenceAlert({ role, converged, stored: v.value.toString(), attested: attested.toString() });
      if (a) out.push(a);
    } catch (e) {
      unread.push(`feeds-not-converged-${role}`);
      out.push({ level: "warn", key: `feeds-not-converged-unread-${role}`, msg: `whether sIMD's ${role} leg has converged cannot be read (${reasonOf(e)}): whether sIMD borrowing is open is unknown` });
    }
  }
  return { alerts: out, unread };
}

// ---------------------------------------------------------------- reading

/** The median the panel would compute for a window ending at the head (as the v1 keeper computes it): its own samples, read at past blocks. Needs archive reads. */
export async function projectMedian({ provider, live, body, headBlock }) {
  const hours = Number(body.window?.hours);
  const samples = Number(/samples (\d+)/.exec(body.definitions?.recipe ?? "")?.[1]);
  if (!hours || !samples) throw new Error("the body names no samples");
  const [manager, poolId, baseIsToken0] = await Promise.all([live.manager(), live.poolId(), live.baseIsToken0()]);
  if (baseIsToken0) throw new Error("unexpected pool direction");
  const pm = new Contract(manager, EXTSLOAD, provider);
  const slot = utils.keccak256(utils.defaultAbiCoder.encode(["bytes32", "uint256"], [poolId, V4_POOLS_SLOT]));
  const span = hours * BLOCKS_PER_HOUR;
  const blocks = Array.from({ length: samples }, (_, i) => headBlock - span + Math.round((i * span) / (samples - 1)));
  const values = await Promise.all(blocks.map(async (b) => {
    const sqrt = BigNumber.from(await pm.extsload(slot, { blockTag: b })).and(BigNumber.from(1).shl(160).sub(1));
    return E18.mul(BigNumber.from(1).shl(192)).div(sqrt.mul(sqrt));
  }));
  const sorted = [...values].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
  const mid = Math.floor(samples / 2);
  return samples % 2 ? sorted[mid] : sorted[mid - 1].add(sorted[mid]).div(2);
}

export function simdBook(book) {
  const t = book.ilks.find((x) => x.name === "SIMD");
  if (!t) return null;
  // spot = the proven pool price (wei of ETH per 1e18 IMD, the median's unit): read only, the depth round proves it.
  return { t, median: book.leaf(book.record.feeds[FEED_NODE.imdMedian]), spot: book.feed(book.record.feeds[FEED_NODE.imdProven]), nhi: book.leaf(t.config.nhi), pool: book.live(book.record.feeds[FEED_NODE.imdLive]), usdLive: book.feed(t.config.liveSpot) };
}

async function loansOf(ctx, t) {
  const index = await freshIndex(ctx);
  return Promise.all((index[t.id] ?? []).map(async (id) => {
    const [p, debt] = await Promise.all([ctx.book.ledger.position(id), ctx.book.ledger.debtOf(id)]);
    return { id, collateral: p.collateral, debt };
  }));
}

// ---------------------------------------------------------------- the loop

export async function runFeeds(ctx) {
  const { book, cfg, log, provider } = ctx;
  const raised = [];
  const raise = (level, key, msg) => raised.push({ level, key, msg });
  // Keys this pass could not evaluate: a standing alert under them stays (it is neither raised nor cleared).
  const unread = [];
  ctx.planeState = await plane(provider, cfg, ctx.fetchImpl ?? fetch);
  // A hold that lasts is an incident, not a note (audit wave 4, C6): a hostile or broken plane can hold it as long as it likes.
  if (!ctx.planeState.ok) {
    const since = readStateOr("plane-hold.json", {}).since ?? Date.now();
    writeState("plane-hold.json", { since });
    const held = Math.floor((Date.now() - since) / 1000);
    const late = held >= (cfg.PLANE?.holdCriticalSeconds ?? 2 * 3600);
    raise(late ? "critical" : "warn", "feeds-plane-hold", `no answer is bought${late ? ` for ${Math.floor(held / 60)} min` : ""}: ${ctx.planeState.why}`);
  } else if (readStateOr("plane-hold.json", {}).since) writeState("plane-hold.json", {}); // advisory: an unreadable one is moved aside first
  await advanceOrders(ctx);

  const S = simdBook(book);
  const { now, number } = await head(provider);
  if (S) {
    const debt = await book.ledger.ilkDebt(S.t.id);
    // Each decision on its own (audit wave 4, P1): one that throws (a bad read, a hostile /swarm) is logged and alerted, never takes
    // the other duties of this pass with it, and keeps the alerts it alone could have raised or cleared.
    const isolated = async (name, keys, fn) => {
      try {
        return await fn();
      } catch (e) {
        if (isUnreadable(e)) throw e;
        log(`feeds   ${name} failed: ${reasonOf(e)}`);
        raise("warn", `feeds-${name}-failed`, `the ${name} decision could not be made this pass: ${reasonOf(e)}`);
        unread.push(...keys);
        return { buy: false, kind: "error", why: reasonOf(e) };
      }
    };
    const nhiOut = await isolated("nhi", ["feeds-nhi-gap", "feeds-buy-held", "feeds-question-mismatch"], () => decideNhi(ctx, S, debt, now, raise));
    const fallOut = await isolated("fall", ["feeds-walking", "feeds-unseeded", "feeds-buy-held", "feeds-question-mismatch"], () => decideFall(ctx, S, now, number, raise));
    if (ctx.keeperAddress) {
      const balance = await book.token(IMD).balanceOf(ctx.keeperAddress);
      const need = nhiOut.buy || fallOut.buy || !debt.isZero() ? cfg.IMD?.pricePerQuestion * 2 || 1 : 0;
      for (const a of imdAlerts({ balance, warnImd: cfg.IMD?.warnBalance ?? 5, needImd: need, inUse: !debt.isZero() })) raise(a.level, a.key, a.msg);
    }
    const conv = await convergenceAlerts(S);
    for (const a of conv.alerts) raise(a.level, a.key, a.msg);
    unread.push(...conv.unread);
    const proven = await provenSpotAlerts(S, now, cfg);
    for (const a of proven.alerts) raise(a.level, a.key, a.msg);
    unread.push(...proven.unread);
    // Design C: legs apart = sIMD priced at low = m > s ? max(s, min(m, attestedMedian)) : s (Pricer twin rule). Ask for a proof now so a
    // real fall can be liquidated at once; proveNow proves only on proveNeeded's gates (pool > 1.5% off the proof, within 1 h of the
    // 6 h max age, or stale): legs apart alone, with the pool still on its proof (the median is the odd one out), proves nothing.
    const q = await book.pricer.quote(S.t.id);
    if (q.priced && !q.agree) await proveNow(ctx, "sIMD legs apart");
    log(`feeds   nhi ${nhiOut.kind}; price ${fallOut.kind}: ${fallOut.why}`);
  }
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  const standing = Object.keys(readStateOr("alerts.json", {}));
  const kept = standing.filter((k) => /^feeds-(order|answer)/.test(k) || unread.includes(k));
  await ctx.alerts.settle("feeds-", new Set([...raised.map((a) => a.key), ...kept]));
}

async function decideFall(ctx, S, now, number, raise) {
  const { book, cfg } = ctx;
  const [m, [spot], poolRead, q] = await Promise.all([S.median.latestValue(), S.spot.latestValue(), S.pool.latestValue(), book.pricer.quote(S.t.id)]);
  // The spot is the proven pool price, read through FEED_ABI (unnamed outputs): index it, never `.value` (fork e2e, design C).
  const [usd] = await S.usdLive.latestValue();
  const loans = await loansOf(ctx, S.t);
  const minDebt = E18.mul(cfg.RISK?.minDebt ?? 15);
  const marginBps = cfg.RISK?.marginBps ?? 1000;
  const atRisk = usd.isZero() ? [] : loansAtRisk(loans, { price: usd, mat: q.mat, minDebt, marginBps });
  const pool = poolRead[0];
  // The median the panel would answer, and the fall the spot would land. A failed archive read falls back to the pool: at worst an answer is refused.
  let medianGuess = pool;
  if (atRisk.length) {
    try {
      medianGuess = await projectMedian({ provider: ctx.provider, live: S.pool, body: bodyOf("price"), headBlock: number });
    } catch (e) {
      ctx.log(`feeds   median projection failed (${reasonOf(e)}): using the pool`);
    }
  }
  const stored = m.value.isZero() ? medianGuess : await S.median.followOf(medianGuess);
  const seen = readState(FILE, {});
  const d = fallDecision({
    median: m.value, spot, pool, quote: q, live: usd, triggerBps: cfg.FEEDS?.fallTriggerBps ?? 500, atRisk: atRisk.length > 0,
    lastBuyAt: seen.lastFallAt, now, minGapSeconds: cfg.FEEDS?.minSecondsBetweenFalls ?? 1800, hadOpenOrder: openOrders("fall").length > 0,
  });
  ctx.log(`feeds   median ${m.value} spot ${spot} pool ${pool}; ${atRisk.length} of ${loans.length} loan(s) at risk`);
  if (d.buy && !stored.eq(medianGuess)) {
    const cap = (await S.median.maxDeviationBps()).toNumber();
    raise("warn", "feeds-walking", `${atRisk.length} sIMD loan(s) at risk; the median answer ${medianGuess} lands at ${stored} (the epoch's band), about ${stepsNeeded(m.value, medianGuess, cap)} epoch(s) at the ${cap / 100}% cap to reach it; sIMD lends nothing until it converges`);
  }
  if (d.kind === "unseeded" && atRisk.length) raise("critical", "feeds-unseeded", `sIMD debt at risk with an empty leg: the first values are the operator's to seed`);
  if (!d.buy) return d;
  const problems = await leafProblems(S.median, "price");
  if (problems.length) {
    raise("critical", "feeds-question-mismatch", problems.join("; "));
    return { ...d, buy: false, kind: "mismatch", why: problems[0] };
  }
  const cost = costOf(cfg, 1);
  if (!ctx.execute) {
    ctx.log(`would   buy price (${utils.formatEther(cost)} IMD): pool ${pool}, ${atRisk.length} loan(s) at risk`);
    return d;
  }
  const hold = await buyHold(ctx, cost);
  if (hold) {
    raise("warn", "feeds-buy-held", `price due and held: ${hold}`);
    return { ...d, buy: false, kind: "held", why: hold };
  }
  if (!(await ensureAllowance(ctx, cost))) return { ...d, buy: false, kind: "held", why: "Permit2 allowance not ready" };
  const eMedian = await S.median.epoch();
  const questions = [
    { role: "price", leaf: S.median.address, input: await buildInput(S.median, "price", { guards: guardsFor(eMedian.anchor, eMedian.allowanceBps.toNumber(), [medianGuess, pool]) }) },
  ];
  writeState(FILE, { ...seen, lastFallAt: now });
  startOrder("fall", questions);
  await advanceOrders(ctx);
  return d;
}

async function decideNhi(ctx, S, debt, now, raise) {
  const { cfg } = ctx;
  const nhi = await S.nhi.latestValue();
  const age = Number(nhi.updatedAt) === 0 ? Infinity : now - Number(nhi.updatedAt);
  const due = !debt.isZero() && !nhi.value.isZero() && age >= (cfg.FEEDS?.nhiRefreshAfterSeconds ?? 22 * 3600);
  const live = due && ctx.planeState?.base ? await readLiveNhi(ctx.planeState.base, ctx.fetchImpl ?? fetch) : null;
  const d = nhiDecision({
    value: nhi.value, age, refreshAfter: cfg.FEEDS?.nhiRefreshAfterSeconds ?? 22 * 3600, debt,
    acceptsLive: live === null ? null : await S.nhi.accepts(live.toString()), hadOpenOrder: openOrders("nhi").length > 0,
    lastBuyAt: readState(FILE, {}).lastNhiAt, now, minGapSeconds: cfg.FEEDS?.minSecondsBetweenNhi ?? 1800,
  });
  if (d.kind === "gap") raise("critical", "feeds-nhi-gap", `sIMD debt exists, NHI is ${age}s old and the leaf would refuse the live index ${live}`);
  if (!d.buy) return d;
  const problems = await leafProblems(S.nhi, "nhi");
  if (problems.length) {
    raise("critical", "feeds-question-mismatch", problems.join("; "));
    return { ...d, buy: false, kind: "mismatch", why: problems[0] };
  }
  const cost = costOf(cfg, 1);
  if (!ctx.execute) {
    ctx.log(`would   buy NHI (${utils.formatEther(cost)} IMD): ${age}s old`);
    return d;
  }
  // Falls come first: a failing NHI must not spend what one pair needs.
  const hold = await buyHold(ctx, cost, { reserve: utils.parseEther(String(cfg.IMD?.reserveForFalls ?? 1)) });
  if (hold) {
    raise("warn", "feeds-buy-held", `NHI due and held: ${hold}`);
    return { ...d, buy: false, kind: "held", why: hold };
  }
  if (!(await ensureAllowance(ctx, cost))) return { ...d, buy: false, kind: "held", why: "Permit2 allowance not ready" };
  writeState(FILE, { ...readState(FILE, {}), lastNhiAt: now });
  startOrder("nhi", [{ role: "nhi", leaf: S.nhi.address, input: await buildInput(S.nhi, "nhi") }]);
  await advanceOrders(ctx);
  return d;
}
