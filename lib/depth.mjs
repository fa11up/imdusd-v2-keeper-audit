// Depth: every hour at a RANDOM minute, `sample()` on each DepthSampler in the launch record,
// then `ImdDepth.poke()`. The random minute is the defence: a sampler bucket keeps the minimum of every sample in its hour, so JIT
// liquidity around somebody else's sample cannot raise it. A sampler that reverts (PoolOffReference, StaleFeed, WalkTooLong)
// records nothing: report it, keep going, and still poke. A day with no poke reads as ZERO depth for a week (the 7-day low fails
// closed), so the poke is the one thing that must land: the hour stays open until it has, and from POKE_URGENT_AFTER into a UTC day
// with no poke yet it goes out on the urgent tier, past the routine gas ceiling and ETH floor.
//
// Gas: one Multicall3 transaction per round, and no poke when it would write nothing (the same chain result). The round is simulated
// first and only the calls that succeeded are sent, with allowFailure off: a call allowed to fail lets gas estimation settle on a limit
// where a sample silently runs out of gas. A sampler that starts reverting after the simulation reverts the batch; the poke then goes
// alone and the hour stays open for a fresh round.
import { randomInt } from "node:crypto";
import { BigNumber, Contract } from "ethers";
import { act, head, landed, reasonOf } from "./act.mjs";
import { readStateOr, writeState } from "./state.mjs";
import { buildProof, slot0Key } from "./proof.mjs";

const FILE = "depth.json";
const HOUR = 3600;
const DAY = 86_400;
const POKE_URGENT_AFTER = 18 * HOUR;
const EDGE = 120; // keep clear of the hour's boundaries: a send can take a block or two
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])"];
const LOWS_SLOT = 3; // ImdDepth._lows: `forge inspect ImdDepth storage-layout`. 7 days of 4 slots: { day, n }, hours_, usd[0..1], usd[2..3]
const DAYS = 7;
const UINT112_MAX = (1n << 112n) - 1n;

/** The second of the hour to act at. Never re-rolled within an hour, so a restart cannot be used to predict or repeat it. */
export const rollSecond = (rand = randomInt) => rand(EDGE, HOUR - EDGE);

/** Pure: what this run does, given chain time and the saved state. */
export function depthPlan(now, s, roll = rollSecond) {
  const hour = Math.floor(now / HOUR);
  const cur = s?.hour === hour ? s : { hour, at: hour * HOUR + roll(), done: false };
  if (cur.done) return { state: cur, due: false, why: "done this hour" };
  return { state: cur, due: now >= cur.at, why: now >= cur.at ? "due" : `next at +${cur.at - now}s` };
}

export async function runDepth(ctx) {
  const { book, log, provider } = ctx;
  const { now } = await head(provider);
  const { state, due, why } = depthPlan(now, readStateOr(FILE, null));
  writeState(FILE, state);
  if (!due) return log(`depth   ${why}`);
  const tier = pokeTier(now, (await book.imdDepth.lowOf(0)).day);
  // A read that fails here must not stand between the keeper and the poke: with no reading, poke anyway (a needless poke writes nothing).
  // But a failed read is not "nothing to sample" (audit wave 4, C7): the hour stays open for the next pass, and a poke already sent
  // alone this hour is not sent again on another failed read.
  let round = { calls: [] };
  let poke = true;
  let readOk = false;
  try {
    round = await simulateRound(ctx);
    if (round.failing.length) await ctx.alerts.raise("warn", "depth-sampler-reverted", round.failing.join("; "));
    else await clear(ctx, "depth-sampler-reverted"); // every sampler simulated cleanly
    await clear(ctx, "depth-round-read-failed"); // the round was read
    poke = pokeNeeded(await readLow(ctx, now), now, round.sampled);
    readOk = true;
  } catch (e) {
    await ctx.alerts.raise("warn", "depth-round-read-failed", reasonOf(e));
    if (state.poked) poke = false;
  }
  let cur = state;
  const sendPoke = async () => {
    const r = await act(ctx, "poke ImdDepth", book.imdDepth, "poke", [], { tier });
    if (!landed(r)) await ctx.alerts.raise(tier === "urgent" ? "critical" : "warn", "depth-poke-failed", r.skipped ?? r.refused ?? "no result");
    else {
      writeState(FILE, (cur = { ...cur, poked: true }));
      await clear(ctx, "depth-poke-failed");
    }
    return landed(r);
  };
  // Late in a day with no poke, the poke goes first on its own tier: samples never hold it back.
  if (poke && (tier === "urgent" || !round.calls.length)) {
    if (!(await sendPoke())) return;
    poke = false;
  }
  // Done only when a successful simulation found nothing that could land; a failed read retries next pass.
  if (!round.calls.length) return readOk ? writeState(FILE, { ...cur, done: true }) : undefined;
  const sendRound = async (rd) => {
    const calls = poke ? [...rd.calls, call(book.imdDepth, "poke")] : rd.calls;
    try {
      const proofs = rd.calls.length - rd.samples;
      return await act(ctx, `depth round: ${proofs ? `${proofs} proof(s) + ` : ""}${rd.samples} samples${poke ? " + poke" : ""}`, multicall(ctx), "aggregate3", [calls], { tier: "routine" });
    } catch (e) {
      log(`depth   round failed after its simulation: ${reasonOf(e)}`);
      return { refused: reasonOf(e) };
    }
  };
  let r = await sendRound(round);
  // A proof is of the block before the head it was built at, and ProvenPoolPrice refuses one more than PROVE_WINDOW (32) blocks
  // behind (TooOld). A round whose proof went stale before it landed must not cost the hour's samples: rebuild against the new head
  // and send ONCE more (never a loop); then the poke goes alone as before and the hour stays open.
  if (!landed(r) && !r.pending && round.calls.length > round.samples) {
    try {
      const again = await simulateRound(ctx);
      if (again.calls.length) {
        log(`depth   round with proof(s) failed (${r.refused ?? r.skipped ?? "no result"}): rebuilt on a new head, once`);
        r = await sendRound(again);
      }
    } catch (e) {
      log(`depth   rebuild failed: ${reasonOf(e)}`);
    }
    if (!landed(r)) await ctx.alerts.raise("warn", "depth-proof-late", `the depth round failed twice with fresh proofs (${r.refused ?? r.skipped ?? "no result"}); the hour stays open`);
  }
  // The poke is the one thing that must land, so it goes alone past a batch that was held back or failed. The hour stays open for the samples.
  if (landed(r)) {
    writeState(FILE, { ...cur, done: true });
    await clear(ctx, "depth-proof-late");
    if (poke) await clear(ctx, "depth-poke-failed");
  } else if (poke) await sendPoke();
}

/** Clear one depth key: called only by the success that answers it (a review before wave 5b: depth keys never cleared before). */
const clear = (ctx, key) => ctx.alerts?.settle?.(key, new Set())?.catch(() => {});

const call = (contract, fn) => ({ target: contract.address, allowFailure: false, callData: contract.interface.encodeFunctionData(fn) });
const multicall = (ctx) => ctx.multicall ?? new Contract(MULTICALL3, MULTICALL3_ABI, ctx.provider);

/** Pure: whether a proven reference needs a new proof this round (gas audit 2026-11b: a proof is ~887k gas, so the keeper proves
 *  only when it matters). A pushed price cannot move a proven reference whatever its age; age matters only when the market really
 *  moved, so: prove when the reference is stale or within `marginSeconds` of its max age, when the live pool has drifted more than
 *  `driftBps` from it, or when a sampler refused the reference (PoolOffReference / StaleFeed). */
export function proveNeeded({ stale, age, maxAge, proven, live, refused, driftBps = 150, marginSeconds = 3600 }) {
  if (stale || refused || proven === 0n) return true;
  if (age + marginSeconds >= maxAge) return true;
  const diff = proven > live ? proven - live : live - proven;
  return diff * 10_000n > proven * BigInt(driftBps);
}

/** The pool price ProvenPoolPrice would prove now, read live: slot0 through PoolManager.extsload, the contract's formula. */
async function livePrice(provider, p) {
  const word = BigInt(await provider.call({ to: p.manager, data: EXTSLOAD.encodeFunctionData("extsload", [slot0Key(p.poolId)]) }));
  const sqrtP = word & ((1n << 160n) - 1n);
  if (sqrtP === 0n) return 0n;
  const q = (sqrtP * sqrtP) >> 64n;
  return p.baseIsToken0 ? (q * 10n ** 18n) >> 128n : (10n ** 18n << 128n) / q;
}

/** Proofs of the samplers' references at the block before the head (blockhash(head) reads 0 in the simulation), for the references
 *  that need one (`proveNeeded`), first in the batch: the reference is then that block's END-OF-BLOCK pool price (audit wave 2). */
async function proveCalls(ctx, refusedAny) {
  const { book, provider, cfg, log } = ctx;
  if (!book.proven?.length) return [];
  const { now } = await head(provider);
  const block = (await provider.getBlockNumber()) - 1;
  const out = [];
  for (const p of book.proven) {
    try {
      const [[value, at], stale, maxAge] = await Promise.all([p.feed.latestValue(), p.feed.isStale(), p.feed.maxAge()]);
      const proven = BigInt(value.toString());
      const live = await livePrice(provider, p);
      const need = proveNeeded({ stale, age: now - Number(at), maxAge: maxAge.toNumber(), proven, live, refused: refusedAny, driftBps: cfg?.DEPTH?.proveDriftBps, marginSeconds: cfg?.DEPTH?.proveMarginSeconds });
      if (!need) {
        log(`depth   reference ${p.feed.address.slice(0, 10)} fresh (${now - Number(at)}s old, within drift): no proof`);
        continue;
      }
      const pr = await buildProof(provider, p.manager, p.poolId, block);
      await clear(ctx, `depth-proof-failed-${p.feed.address}`);
      out.push({ target: p.feed.address, allowFailure: false, callData: p.feed.interface.encodeFunctionData("prove", [pr.header, pr.accountProof, pr.storageProof]), feed: p.feed });
    } catch (e) {
      await ctx.alerts.raise("warn", `depth-proof-failed-${p.feed.address}`, `cannot build the proof of block ${block} for ${p.feed.address}: ${reasonOf(e)}; the samplers on it refuse StaleFeed until one lands`);
    }
  }
  return out;
}

/** Prove the depth references now, outside the hourly round, but ONLY when `proveNeeded` says so: the reference is stale, it is within
 *  `proveMarginSeconds` (default 1 h) of its max age (PROVEN_MAX_AGE 6 h), or the live pool has drifted more than `proveDriftBps`
 *  (default 1.5%) from it (`refused` is always false here). Price design C: sIMD's spot IS the proven reference, and while the legs
 *  disagree the Pricer prices sIMD at low = m > s ? max(s, min(m, attestedMedian)) : s (the contracts' Pricer.sol, the twin rule), so
 *  after a real fall the old proven spot props `low` up until a newer block is proved. Anyone may prove (a liquidator proves then
 *  bites). The feeds duty calls this every pass in which the legs are apart; legs apart ALONE proves nothing: a median that moved
 *  while the pool stayed within 1.5% of its proof (the median is the odd one out) gets no proof. Returns whether a proof landed. */
export async function proveNow(ctx, why, { force = false } = {}) {
  const proves = await proveCalls(ctx, force);
  if (!proves.length) return false;
  const calls = proves.map(({ feed, ...c }) => c);
  let r = await act(ctx, `prove now (${why}): ${calls.length} reference(s)`, multicall(ctx), "aggregate3", [calls], { tier: "urgent" });
  // A proof that went stale before it landed (TooOld: > 32 blocks behind the head) is rebuilt against the new head and sent ONCE more.
  if (!landed(r) && !r.pending) {
    const fresh = (await proveCalls(ctx, force)).map(({ feed, ...c }) => c);
    if (fresh.length) r = await act(ctx, `prove now (${why}), rebuilt on a new head: ${fresh.length} reference(s)`, multicall(ctx), "aggregate3", [fresh], { tier: "urgent" });
  }
  if (landed(r)) await clear(ctx, "depth-prove-now-failed");
  if (!landed(r)) await ctx.alerts.raise("warn", "depth-prove-now-failed", `${why}: the proof did not land (${r.skipped ?? r.refused ?? "no result"}); the next depth round retries`);
  return landed(r);
}

const EXTSLOAD = new (await import("ethers")).utils.Interface(["function extsload(bytes32) view returns (bytes32)"]);

/** Every sample, then the depth they leave: which samples would land, and what a poke would then read. */
async function simulateRound(ctx) {
  const { book, keeperAddress, log } = ctx;
  const calls = book.samplers.map((sampler) => call(sampler, "sample"));
  // A first look without proofs: a sampler refusing its reference (stale, or the pool off it) asks for one.
  let refusedAny = false;
  if (book.proven?.length) {
    const first = await multicall(ctx).callStatic.aggregate3(calls.map((c) => ({ ...c, allowFailure: true })), keeperAddress ? { from: keeperAddress } : {});
    refusedAny = first.some((r, i) => {
      if (r.success) return false;
      try {
        return ["StaleFeed", "PoolOffReference"].includes(book.samplers[i].interface.parseError(r.returnData).name);
      } catch {
        return false;
      }
    });
  }
  const proves = await proveCalls(ctx, refusedAny);
  const asked = [...proves, ...calls, call(book.imdDepth, "sampled")].map(({ feed, ...c }) => ({ ...c, allowFailure: true }));
  const res = await multicall(ctx).callStatic.aggregate3(asked, keeperAddress ? { from: keeperAddress } : {});
  // A prove of a block no newer than the held one is a no-op (audit wave 3; it reverted NotNewer before): the reference is
  // then fresh anyway. Any other refusal: leave it out.
  const provesOk = proves.filter((p, i) => {
    if (res[i].success) return true;
    let reason = res[i].returnData;
    try {
      reason = p.feed.interface.parseError(res[i].returnData).name;
    } catch {}
    log(`depth   prove ${p.target.slice(0, 10)} refuses (${reason})`);
    return false;
  }).map(({ feed, ...c }) => c);
  const out = res.slice(proves.length);
  const failing = [];
  book.samplers.forEach((sampler, i) => {
    if (out[i].success) return;
    let reason = out[i].returnData;
    try {
      reason = sampler.interface.parseError(out[i].returnData).name;
    } catch {}
    log(`depth   sample ${sampler.address.slice(0, 10)} refuses (${reason})`);
    failing.push(`${sampler.address}: ${reason}`);
  });
  const last = out[out.length - 1];
  if (!last.success) throw new Error(`ImdDepth.sampled() reverted in simulation: ${reasonOf({ message: last.returnData })}`);
  const samples = calls.filter((_, i) => out[i].success);
  // Proofs go only with samples that use them; a round with no sample to send sends no proof.
  return { calls: samples.length ? [...provesOk, ...samples] : [], samples: samples.length, failing, sampled: BigInt(BigNumber.from(last.returnData).toString()) };
}

/** Today's slot of ImdDepth._lows. It has no getter for `n` and `hours_`, so this reads the layout directly. */
export async function readLow({ provider, book }, now) {
  const base = LOWS_SLOT + (Math.floor(now / DAY) % DAYS) * 4;
  const [head_, hours, u01, u23] = await Promise.all([0, 1, 2, 3].map(async (k) => BigInt(await provider.getStorageAt(book.imdDepth.address, base + k))));
  const byte = (v, i) => Number((v >> BigInt(8 * i)) & 0xffn);
  return {
    day: Number(head_ & 0xffffffffn),
    n: Number((head_ >> 32n) & 0xffn),
    hours: [0, 1, 2, 3].map((i) => byte(hours, i)),
    usd: [u01 & UINT112_MAX, (u01 >> 112n) & UINT112_MAX, u23 & UINT112_MAX, (u23 >> 112n) & UINT112_MAX],
  };
}

/** Pure: whether `ImdDepth.poke()` at `now`, reading `sampled`, would write. Mirrors the contract's early returns (a poke is the same chain result when it would not). */
export function pokeNeeded(low, now, sampled) {
  if (low.day !== Math.floor(now / DAY)) return true;
  const v = sampled > UINT112_MAX ? UINT112_MAX : sampled;
  const hour = Math.floor((now % DAY) / HOUR);
  for (let k = 0; k < low.n; k++) if (low.hours[k] === hour) return v < low.usd[k];
  return low.n < low.usd.length || v < low.usd[low.n - 1];
}

/** Pure: the tier of the poke. `lastDay` is the UTC day of ImdDepth's newest low. */
export const pokeTier = (now, lastDay) => (lastDay !== Math.floor(now / DAY) && now % DAY >= POKE_URGENT_AFTER ? "urgent" : "routine");

const WINDOW_HOURS = 26; // DepthSampler.WINDOW_HOURS
const MIN_FOR_MEDIAN = 8;

/**
 * Pure: a sampler's hourly buckets far from the window's median. A LOW bucket is what a push-sample-push-back leaves
 * (one transaction or bundle, ~2% of the push: not defended on chain, DepthSampler header); a HIGH one is what a sandwich
 * of a public sample leaves (audit wave 1, panel 3). LPs moving for real look the same: the alert says why the line moved, it
 * proves nothing. `buckets` = [{ hour, v }] for the reported side. Returns [{ level, key, msg }].
 */
export function bucketAlerts({ address, buckets, nowHour }) {
  const live = buckets.filter((b) => b.hour !== 0 && b.hour <= nowHour && nowHour - b.hour < WINDOW_HOURS);
  if (live.length < MIN_FOR_MEDIAN) return [];
  const sorted = live.map((b) => b.v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === 0n) return [];
  const usd = (v) => `$${v / 10n ** 18n}`;
  const at = (bs) => bs.map((b) => `${(b.hour % 24).toString().padStart(2, "0")}:00 ${usd(b.v)}`).join(", ");
  const low = live.filter((b) => b.v * 2n < median);
  const high = live.filter((b) => b.v * 2n > median * 3n);
  const out = [];
  if (low.length) out.push({ level: "warn", key: `depth-low-sample-${address}`, msg: `${address}: ${low.length} hour(s) under half the window median ${usd(median)} (${at(low)}). A pool push around a sample (~2% of the push) or LPs leaving; 4 such hours lower the sIMD line ~8 days` });
  if (high.length) out.push({ level: "warn", key: `depth-high-sample-${address}`, msg: `${address}: ${high.length} hour(s) over 1.5x the window median ${usd(median)} (${at(high)}). A sandwiched sample (is the keeper sending privately?) or new LPs` });
  return out;
}

/** Pure: the alerts the depth readings call for. Returns [{ level, key, msg }]. */
export function depthAlerts({ samplers, today, yesterday, depthIMD, simdLine, warmedUp }) {
  const out = [];
  for (const s of samplers) {
    if (warmedUp && s.age > 2 * HOUR) out.push({ level: "critical", key: `depth-sample-age-${s.address}`, msg: `sampleAge ${s.age}s > 2 h on ${s.address}: past ~6 missed hours the sampler reads 0 and new sIMD borrowing closes ~8 days` });
    if (warmedUp && s.filled < 22) out.push({ level: "warn", key: `depth-buckets-${s.address}`, msg: `filledBuckets ${s.filled} < 22 on ${s.address} (under 20 it reads 0 depth)` });
  }
  if (yesterday > 0n && today * 10n < yesterday * 7n) {
    out.push({ level: "warn", key: "depth-falling", msg: `depth low fell over 30% day on day: $${today / 10n ** 18n} from $${yesterday / 10n ** 18n}` });
  }
  if (depthIMD === 0n) {
    // A 7-day low reads 0 for the first week by design; it only stops anything once sIMD has a line.
    out.push(simdLine > 0n
      ? { level: "critical", key: "depth-zero", msg: "Parameters.depthIMD() is 0: sIMD borrowing has stopped (the rule binds live)" }
      : { level: "info", key: "depth-zero", msg: "Parameters.depthIMD() is 0 and the sIMD line is 0: nothing stopped yet" });
  }
  return out;
}
