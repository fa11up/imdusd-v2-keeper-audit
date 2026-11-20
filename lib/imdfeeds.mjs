// The IMD type's swarm legs on Robinhood Chain (RobinhoodConfig: F_IMD_ETH = SWARM_PRICE, F_IMD_ETH_SPOT = SWARM_SPOT, F_NHI; the
// type's price and spot are those x Chainlink ETH/USD on 4663). Both legs are swarm leaves here: 4663 has no proven or live leg, so on a
// fall the keeper buys BOTH, as one oracle.group order (v1's rule: price and spot as one oracle.group order).
// The same refresh rules as mainnet's sIMD (lib/feeds.mjs, whose pure decisions are reused unchanged):
//   1. FALLS ONLY: price + spot only when the MAINNET pool (the questions read Ethereum's v4 IMD/ETH pool 0xb07d) is fallTriggerBps under
//      what the 4663 Pricer measures IMD loans at, and only while a loan of RISK.minDebt or more would be under mat + marginBps there.
//   2. NEVER A RISE. 3. NHI once a day, only while IMD debt exists on 4663. 4. An empty leaf is never bought (the deployment's to seed).
// CONSUMER = {chainId 4663, verifyingContract: the 4663 leaf}: an attestation binds to one leaf through its EIP-712 domain, so every IMD
// update is bought twice if both chains need it. The questions are the mainnet bodies, byte for byte (the 4663 leaves pin the
// same SwarmQuestions PRICE/SPOT/NHI), and leafProblems checks that against the 4663 leaf before anything is paid.
// PAYMENT is on Ethereum (Permit2 over mainnet IMD) from this process's own key; reads of it go through the mainnet peer (ctx.pay), and
// this process never sends a mainnet transaction (lib/orders.mjs). RELAY is on 4663, checked against the L1 block number the leaf sees.
// OFF BY DEFAULT: IMD opens at line 0 (RobinhoodConfig IMD_LINE is the plan, the genesis line is the Safe's), so IMD_FEEDS.buy is false
// until the operator turns it on; every decision is still made, logged and alerted.
import { BigNumber, Contract, utils } from "ethers";
import { head, reasonOf } from "./act.mjs";
import { convergenceAlert, fallDecision, imdAlerts, loansAtRisk, nhiDecision, projectMedian, walkDue } from "./feeds.mjs";
import { bodyOf, buildInput, guardsFor, leafProblems, stepsNeeded } from "./oracle.mjs";
import { advanceOrders, buyHold, costOf, ensureAllowance, openOrders, startOrder } from "./orders.mjs";
import { plane, readLiveNhi } from "./plane.mjs";
import { freshIndex } from "./positions.mjs";
import { declareShape, isUnreadable, readState, readStateOr, writeState } from "./state.mjs";
import { IMD } from "./x402.mjs";

const E18 = BigNumber.from(10).pow(18);
const FILE = "imd-feeds.json";
declareShape(FILE, (v) => (v && typeof v === "object" && !Array.isArray(v) ? null : "not an object"));
const EXTSLOAD = ["function extsload(bytes32) view returns (bytes32)"];
const V4_POOLS_SLOT = 6;

/** The pool the questions read, from the frozen price body's recipe (one source). */
export function questionPool(body = bodyOf("price")) {
  const r = body.definitions?.recipe ?? "";
  const manager = /poolManager (0x[0-9a-fA-F]{40})/.exec(r)?.[1];
  const poolId = /poolId (0x[0-9a-fA-F]{64})/.exec(r)?.[1];
  if (!manager || !poolId) throw new Error("the price body names no pool");
  return { manager, poolId, live: { manager: async () => manager, poolId: async () => poolId, baseIsToken0: async () => false } };
}

/** wei of ETH per 1e18 IMD at the pool's slot0, read on Ethereum (the question's own unit and direction: invert false). */
export async function poolPrice(mainnet, { manager, poolId }, blockTag = "latest") {
  const pm = new Contract(manager, EXTSLOAD, mainnet);
  const slot = utils.keccak256(utils.defaultAbiCoder.encode(["bytes32", "uint256"], [poolId, V4_POOLS_SLOT]));
  const sqrt = BigNumber.from(await pm.extsload(slot, { blockTag })).and(BigNumber.from(1).shl(160).sub(1));
  if (sqrt.isZero()) return BigNumber.from(0);
  return E18.mul(BigNumber.from(1).shl(192)).div(sqrt.mul(sqrt));
}

export async function runImdFeeds(ctx) {
  const { book, cfg, log, provider } = ctx;
  const T = book.imd;
  if (!T) return log("imdfeeds no IMD type with swarm leaves");
  const mainnet = ctx.pay?.provider ?? ctx.peers?.[1];
  if (!mainnet) throw new Error("the IMD legs need a mainnet read provider (PEERS[1])");
  const raised = [];
  const raise = (level, key, msg) => raised.push({ level, key, msg });
  const unread = [];
  ctx.planeState = await plane(mainnet, cfg, ctx.fetchImpl ?? fetch);
  if (!ctx.planeState.ok) raise("warn", "imdfeeds-plane-hold", `no IMD answer is bought: ${ctx.planeState.why}`);
  await advanceOrders(ctx);
  const { now } = await head(provider);
  const debt = await book.ledger.ilkDebt(T.id);
  const buying = cfg.IMD_FEEDS?.buy === true;
  const isolated = async (name, keys, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (isUnreadable(e)) throw e;
      log(`imdfeeds ${name} failed: ${reasonOf(e)}`);
      raise("warn", `imdfeeds-${name}-failed`, `the IMD ${name} decision could not be made this pass: ${reasonOf(e)}`);
      unread.push(...keys);
      return { buy: false, kind: "error", why: reasonOf(e) };
    }
  };
  const fallOut = await isolated("fall", ["imdfeeds-buy-held", "imdfeeds-question-mismatch", "imdfeeds-walking"], () => decideFall(ctx, T, mainnet, now, raise, buying));
  const nhiOut = await isolated("nhi", ["imdfeeds-nhi-gap", "imdfeeds-buy-held", "imdfeeds-question-mismatch"], () => decideNhi(ctx, T, debt, now, raise, buying));
  if (ctx.keeperAddress && !debt.isZero()) {
    const balance = await new Contract(IMD, ["function balanceOf(address) view returns (uint256)"], mainnet).balanceOf(ctx.keeperAddress);
    for (const a of imdAlerts({ balance, warnImd: cfg.IMD?.warnBalance ?? 5, needImd: (cfg.IMD?.pricePerQuestion ?? 0.5) * 2, inUse: true })) raise(a.level, a.key.replace(/^feeds-/, "imdfeeds-"), `${a.msg} (on Ethereum: it pays for 4663 answers)`);
  }
  for (const [role, leaf] of [["median", T.leaves.median], ["spot", T.leaves.spot], ["nhi", T.leaves.nhi]]) {
    try {
      const [converged, attested, v] = await Promise.all([leaf.converged(), leaf.attested(), leaf.latestValue()]);
      const a = convergenceAlert({ role, converged, stored: v.value.toString(), attested: attested.toString() });
      if (a) raise(a.level, a.key.replace(/^feeds-/, "imdfeeds-"), a.msg.replace(/^sIMD/, "4663 IMD"));
    } catch (e) {
      unread.push(`imdfeeds-not-converged-${role}`);
    }
  }
  log(`imdfeeds price ${fallOut.kind}: ${fallOut.why}; nhi ${nhiOut.kind}${buying ? "" : " (buying OFF)"}`);
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  const kept = Object.keys(readStateOr("alerts.json", {})).filter((k) => /^feeds-(order|answer)/.test(k) || unread.includes(k));
  await ctx.alerts.settle("imdfeeds-", new Set([...raised.map((a) => a.key), ...kept]));
}

async function decideFall(ctx, T, mainnet, now, raise, buying) {
  const { book, cfg } = ctx;
  const L = T.leaves;
  const P = questionPool();
  const [m, s, q, [ethUsd], pool, mainHead] = await Promise.all([L.median.latestValue(), L.spot.latestValue(), book.pricer.quote(T.id), L.ethUsd.latestValue(), poolPrice(mainnet, P), mainnet.getBlockNumber()]);
  const live = pool.mul(ethUsd).div(E18); // USD per 1e18 IMD, the unit of quote.low
  const index = await freshIndex(ctx);
  const loans = await Promise.all((index[T.id] ?? []).map(async (id) => ({ id, collateral: (await book.ledger.position(id)).collateral, debt: await book.ledger.debtOf(id) })));
  const atRisk = live.isZero() ? [] : loansAtRisk(loans, { price: live, mat: q.mat, minDebt: E18.mul(cfg.RISK?.minDebt ?? 15), marginBps: cfg.RISK?.marginBps ?? 1000 });
  const seen = readState(FILE, {});
  const d = fallDecision({
    median: m.value, spot: s.value, pool, quote: q, live, triggerBps: cfg.FEEDS?.fallTriggerBps ?? 500, atRisk: atRisk.length > 0,
    lastBuyAt: seen.lastFallAt, now, minGapSeconds: cfg.FEEDS?.minSecondsBetweenFalls ?? 1800, hadOpenOrder: openOrders("fall").length > 0,
  });
  // Since the wave-5 price fixes: the IMD/ETH leg no longer widens after a silence either: walk a held median on once per epoch.
  if (!d.buy && !m.value.isZero() && loans.some((l) => !BigNumber.from(l.debt).isZero())) {
    const [converged, attested, ep] = await Promise.all([L.median.converged(), L.median.attested(), L.median.epoch()]);
    if (walkDue({ converged, attested, stored: m.value, epochOpenedAt: ep.openedAt, lastWalkEpoch: seen.lastWalkEpoch, hadOpenOrder: openOrders("fall").length > 0 })) {
      d.buy = true;
      d.kind = "walk";
      d.why = `the 4663 IMD median ${m.value} is held above its last answer ${attested}: one honest median this epoch walks it on`;
      seen.lastWalkEpoch = Number(ep.openedAt);
    }
  }
  if (!d.buy) return d;
  let medianGuess = pool;
  try {
    medianGuess = await projectMedian({ provider: mainnet, live: P.live, body: bodyOf("price"), headBlock: mainHead });
  } catch (e) {
    ctx.log(`imdfeeds median projection failed (${reasonOf(e)}): using the pool`);
  }
  const stored = await L.median.followOf(medianGuess);
  if (!stored.eq(medianGuess)) {
    const cap = (await L.median.maxDeviationBps()).toNumber();
    raise("warn", "imdfeeds-walking", `${atRisk.length} 4663 IMD loan(s) at risk; the median answer ${medianGuess} lands at ${stored}, about ${stepsNeeded(m.value, medianGuess, cap)} epoch(s) to reach it`);
  }
  const problems = [...(await leafProblems(L.median, "price")), ...(await leafProblems(L.spot, "spot"))];
  if (problems.length) {
    raise("critical", "imdfeeds-question-mismatch", problems.join("; "));
    return { ...d, buy: false, kind: "mismatch", why: problems[0] };
  }
  const cost = costOf(cfg, 2);
  if (!buying || !ctx.execute) {
    ctx.log(`would   buy 4663 IMD price + spot (${utils.formatEther(cost)} IMD): pool ${pool}, ${atRisk.length} loan(s) at risk${buying ? "" : "; IMD_FEEDS.buy is off"}`);
    return { ...d, kind: buying ? "would-buy" : "off" };
  }
  const hold = await buyHold(ctx, cost);
  if (hold) {
    raise("warn", "imdfeeds-buy-held", `4663 IMD price + spot due and held: ${hold}`);
    return { ...d, buy: false, kind: "held", why: hold };
  }
  if (!(await ensureAllowance(ctx, cost))) return { ...d, buy: false, kind: "held", why: "Permit2 allowance not ready" };
  const [eM, eS] = await Promise.all([L.median.epoch(), L.spot.epoch()]);
  const questions = [
    { role: "price", leaf: L.median.address, input: await buildInput(L.median, "price", { consumerChainId: 4663, guards: guardsFor(eM.anchor, eM.allowanceBps.toNumber(), [medianGuess, pool]) }) },
    { role: "spot", leaf: L.spot.address, input: await buildInput(L.spot, "spot", { consumerChainId: 4663, guards: guardsFor(eS.anchor, eS.allowanceBps.toNumber(), [pool]) }) },
  ];
  writeState(FILE, { ...seen, lastFallAt: now });
  startOrder("fall", questions);
  await advanceOrders(ctx);
  return d;
}

async function decideNhi(ctx, T, debt, now, raise, buying) {
  const { cfg } = ctx;
  const leaf = T.leaves.nhi;
  const nhi = await leaf.latestValue();
  const age = Number(nhi.updatedAt) === 0 ? Infinity : now - Number(nhi.updatedAt);
  const refreshAfter = cfg.FEEDS?.nhiRefreshAfterSeconds ?? 22 * 3600;
  const due = !debt.isZero() && !nhi.value.isZero() && age >= refreshAfter;
  const live = due && ctx.planeState?.base ? await readLiveNhi(ctx.planeState.base, ctx.fetchImpl ?? fetch) : null;
  const d = nhiDecision({
    value: nhi.value, age, refreshAfter, debt, acceptsLive: live === null ? null : await leaf.accepts(live.toString()),
    hadOpenOrder: openOrders("nhi").length > 0, lastBuyAt: readState(FILE, {}).lastNhiAt, now, minGapSeconds: cfg.FEEDS?.minSecondsBetweenNhi ?? 1800,
  });
  if (d.kind === "gap") raise("critical", "imdfeeds-nhi-gap", `4663 IMD debt exists, NHI is ${age}s old and the leaf would refuse the live index ${live}`);
  if (!d.buy) return d;
  const problems = await leafProblems(leaf, "nhi");
  if (problems.length) {
    raise("critical", "imdfeeds-question-mismatch", problems.join("; "));
    return { ...d, buy: false, kind: "mismatch", why: problems[0] };
  }
  const cost = costOf(cfg, 1);
  if (!buying || !ctx.execute) {
    ctx.log(`would   buy 4663 NHI (${utils.formatEther(cost)} IMD): ${age}s old${buying ? "" : "; IMD_FEEDS.buy is off"}`);
    return { ...d, kind: buying ? "would-buy" : "off" };
  }
  const hold = await buyHold(ctx, cost, { reserve: utils.parseEther(String(cfg.IMD?.reserveForFalls ?? 1)) });
  if (hold) {
    raise("warn", "imdfeeds-buy-held", `4663 NHI due and held: ${hold}`);
    return { ...d, buy: false, kind: "held", why: hold };
  }
  if (!(await ensureAllowance(ctx, cost))) return { ...d, buy: false, kind: "held", why: "Permit2 allowance not ready" };
  writeState(FILE, { ...readState(FILE, {}), lastNhiAt: now });
  startOrder("nhi", [{ role: "nhi", leaf: leaf.address, input: await buildInput(leaf, "nhi", { consumerChainId: 4663 }) }]);
  await advanceOrders(ctx);
  return d;
}
