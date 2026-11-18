// The guardian: reads conditions and, when one holds, raises a CRITICAL alert telling the Safe to freeze the Allocator (`Allocator.freeze()` from the
// Safe). It holds NO key and sends nothing (the guardian key was removed; the Allocator's freezer is the Safe from genesis, and the
// four discretionary Allocator jobs are rule-driven, bounded by the Safe's buckets). A freeze stops every keeper and rule-driven action and moves
// nothing; only the Safe undoes it. So act only on signs the funds' controls no longer hold, never on market weather. Until the Safe has signed,
// what bounds a loss is each action's daily bucket.
//
// THE CONDITIONS, each config, none time-of-day. At once, because each is proof, not a reading:
//   unknown-actor   an `Acted` on the Allocator from anyone but a known keeper or the governor;
//   keeper-replayed an `Acted` from this keeper's address in a transaction this keeper never signed: the key is out (only while the guardian shares the keeper's state dir);
//   unknown-keeper  `KeeperSet(k, true)` for an address not in GUARDIAN.knownKeepers: the Safe adding a keeper nobody told this box about.
// Only after holding for a while, because each is a reading that a block can fake or a feed hiccup can trip:
//   unbacked-braked `Ledger.unbacked()` past the brake (`unbackedBrake` x circulating): the protocol has stopped lending, and its funds should not move until a human looks;
//   quote-depeg     `PegHook.quoteSound()` false: the Allocator may be holding or buying a falling USDC, or the feed has stopped (fail closed either way);
//   simd-off-pool   fresh attested sIMD legs more than GUARDIAN.simdOffPoolBps from the live pool. An accepted risk (the audit README, known issues) is that "a wrong attested pair, or a compromised
//                   attester key" walks sIMD "until someone pauses". This does not stop that: it stops the Allocator selling the edge sleeve's sIMD at that price.
// NOT conditions on purpose: the peg itself, a depth fall, stale feeds alone, gas. Those are market weather, the Safe's or the keeper's job. The bridge guardian (pause, nilify) is after the beta and not here.
import { utils } from "ethers";
import { head } from "./act.mjs";
import { signedHashes } from "./journal.mjs";
import { simdBook } from "./feeds.mjs";
import { readStateOr, writeState } from "./state.mjs";

const FILE = "guardian.json";
const lc = (a) => String(a).toLowerCase();

/** Pure: the proof conditions, from what the Allocator's logs say. `ownHashes` null = no journal to compare with. */
export function logConditions({ acted, keeperAdds, known, keeper, governor, ownHashes }) {
  const knownSet = new Set([...known.map(lc), ...(keeper ? [lc(keeper)] : [])]);
  const out = [];
  for (const a of acted) {
    // A Safe's transaction comes from whichever signer sent it, so the governor is read from where it went, not who sent it.
    if (lc(a.from) === lc(governor) || (a.to && lc(a.to) === lc(governor))) continue;
    if (!knownSet.has(lc(a.from))) out.push({ key: "unknown-actor", why: `Allocator acted (${a.action}) in ${a.hash} from ${a.from}, not a known keeper` });
    else if (ownHashes && keeper && lc(a.from) === lc(keeper) && !ownHashes.has(lc(a.hash))) out.push({ key: "keeper-replayed", why: `${a.hash} acted from the keeper's address and this keeper never signed it: the key is out` });
  }
  for (const k of keeperAdds) if (!knownSet.has(lc(k))) out.push({ key: "unknown-keeper", why: `KeeperSet added ${k}, not in GUARDIAN.knownKeepers` });
  return out;
}

/** Pure: the held conditions. `since` is key -> first seen; returns { fire, since }. */
export function heldConditions({ readings, confirm, since, now }) {
  const next = {};
  const fire = [];
  for (const [key, on, why] of readings) {
    if (!on) continue;
    next[key] = since[key] ?? now;
    if (now - next[key] >= (confirm[key] ?? 0)) fire.push({ key, why: `${why} (held ${now - next[key]}s)` });
  }
  return { fire, since: next };
}

/** Pure: is a fresh leg off the pool by more than `bps`? */
export function offPool({ fresh, value, pool, bps }) {
  if (!fresh || value.isZero() || pool.isZero()) return false;
  const gap = value.gt(pool) ? value.sub(pool) : pool.sub(value);
  return gap.mul(10_000).gt(pool.mul(bps));
}

export async function runGuardian(ctx) {
  const { book, cfg, provider, log, keeperAddress } = ctx;
  const G = cfg.GUARDIAN ?? {};
  const al = book.allocator;
  const [frozen, governor] = await Promise.all([al.frozen(), al.governor()]);
  const { now, number } = await head(provider);
  const s = readStateOr(FILE, { next: Number(G.fromBlock ?? book.record.stage4SimulatedAtBlock ?? number), since: {} });

  // --- the Allocator's logs, from where the last pass stopped
  const to = number - (G.logLag ?? 2);
  const acted = [];
  const keeperAdds = [];
  if (to >= s.next) {
    const chunk = G.logChunk ?? 9_000;
    for (let from = s.next; from <= to; from += chunk) {
      const logs = await provider.getLogs({ address: al.address, fromBlock: from, toBlock: Math.min(to, from + chunk - 1) });
      for (const l of logs) {
        let parsed;
        try { parsed = al.interface.parseLog(l); } catch { continue; }
        if (parsed.name === "Acted") {
          const tx = await provider.getTransaction(l.transactionHash);
          acted.push({ hash: l.transactionHash, action: utils.parseBytes32String(parsed.args.action), from: tx.from, to: tx.to });
        }
        if (parsed.name === "KeeperSet" && parsed.args.isKeeper) keeperAdds.push(parsed.args.keeper);
      }
    }
  }
  // Report-only with no KEEPER_ADDRESS cannot tell the keeper from a stranger: it judges nothing rather than calling the keeper one.
  const proofs = logConditions({ acted: keeperAddress ? acted : [], keeperAdds: keeperAddress ? keeperAdds : [], known: G.knownKeepers ?? [], keeper: keeperAddress, governor, ownHashes: G.compareJournal === false || !ctx.execute ? null : signedHashes("tx") });

  // --- the readings
  const [unbacked, brake, circulating, sound] = await Promise.all([book.ledger.unbacked(), book.params.unbackedBrake(), book.usd.circulating(), book.pegHook.quoteSound()]);
  const allowed = circulating.mul(brake).div(utils.parseEther("1"));
  const S = simdBook(book);
  let offMsg = "";
  let isOff = false;
  if (S) {
    const [m, sp, stM, stS, pool] = await Promise.all([S.median.latestValue(), S.spot.latestValue(), S.median.isStale(), S.spot.isStale(), S.pool.latestValue()]);
    const bps = G.simdOffPoolBps ?? 3000;
    isOff = offPool({ fresh: !stM, value: m.value, pool: pool[0], bps }) || offPool({ fresh: !stS, value: sp.value, pool: pool[0], bps });
    offMsg = `attested sIMD legs ${m.value}/${sp.value} are over ${bps / 100}% from the pool ${pool[0]}`;
  }
  const { fire, since } = heldConditions({
    readings: [
      ["unbacked-braked", unbacked.gt(allowed), `unbacked ${utils.formatEther(unbacked)} imdUSD past the brake ${utils.formatEther(allowed)}`],
      ["quote-depeg", !sound, "PegHook.quoteSound() is false"],
      ["simd-off-pool", isOff, offMsg],
    ],
    confirm: { "unbacked-braked": G.unbackedConfirmSeconds ?? 120, "quote-depeg": G.quoteDepegConfirmSeconds ?? 900, "simd-off-pool": G.simdOffPoolConfirmSeconds ?? 900 },
    since: s.since,
    now,
  });
  // A proof in the logs is read once and must hold until the Allocator is frozen (the cursor has moved past it), or until a person removes
  // state/guardian.json after looking. The Safe's unfreeze answers it.
  const sticky = frozen ? [] : [...(s.proofs ?? []), ...proofs].filter((p, i, all) => all.findIndex((x) => x.why === p.why) === i);
  const conditions = [...sticky, ...fire];
  writeState(FILE, { next: Math.max(s.next, to + 1), since, proofs: sticky });

  const raised = [];
  if (conditions.length && !frozen) {
    const why = conditions.map((c) => `${c.key}: ${c.why}`).join("; ");
    raised.push({ level: "critical", key: "guardian-freeze-now", msg: `the Safe should FREEZE the Allocator now (Allocator.freeze() from the Safe): ${why}` });
  }
  log(`guardian ${frozen ? "allocator frozen; " : ""}${conditions.length ? conditions.map((c) => c.key).join(", ") : "clear"}`);
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("guardian-", new Set(raised.map((a) => a.key)));
}
