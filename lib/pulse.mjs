// The Pulse (src/Pulse.sol in the contracts): Robinhood Chain has no Chainlink sequencer-uptime feed, so the protocol watches its own
// liveness. A poke that finds more than `gap` (15 min) since the last one opens a `grace` (1 h) in which positions may be marked but
// nothing is seized, and redemption refuses (wave 4). A quiet chain looks like a halted one, so somebody must poke more often than
// `gap` or every quiet quarter-hour holds liquidations for an hour. That somebody is this loop (carried over from the v1 keeper's Robinhood keeper).
//
// CHEAPEST POKE: `Pulse.poke()` itself. Every Ledger accrual, mark and bite pokes too, so the loop reads `lastPulse` and pokes only when
// nobody has for PULSE.pokeAfterSeconds (default 480: with the loop every minute the gap never passes ~9 minutes, inside the 15).
// URGENT tier: a missed poke holds every liquidation for an hour, and a 4663 poke costs ~2e-6 ETH.
import { act, head } from "./act.mjs";

/** Pure: poke now? { due, silence, opensGrace }. `opensGrace`: this poke itself starts a grace (the chain was silent past the gap). */
export function pulseDue({ now, lastPulse, gap, pokeAfter }) {
  const silence = now - lastPulse;
  return { due: silence >= pokeAfter, silence, opensGrace: silence > gap };
}

/** Pure: the alerts the Pulse's state calls for. */
export function pulseAlerts({ now, lastPulse, gap, graceUntil, inGrace }) {
  const out = [];
  const silence = now - lastPulse;
  if (inGrace) out.push({ level: "critical", key: "pulse-grace", msg: `the 4663 Pulse is in grace${graceUntil > now ? ` until ${new Date(graceUntil * 1000).toISOString()}` : ` (${silence}s since the last poke, over the ${gap}s gap)`}: liquidations and redemption wait` });
  else if (silence > gap * 0.75) out.push({ level: "warn", key: "pulse-silent", msg: `${silence}s since the last Pulse poke (gap ${gap}s): a grace opens at the next poke past the gap` });
  return out;
}

export async function runPulse(ctx) {
  const { book, cfg, log, provider } = ctx;
  if (!book.pulse) return log("pulse   this deployment has no Pulse");
  const p = book.pulse;
  const [{ now }, last, gap, graceUntil, inGrace] = await Promise.all([head(provider), p.lastPulse(), p.gap(), p.graceUntil(), p.inGrace()]);
  const d = pulseDue({ now, lastPulse: Number(last), gap: Number(gap), pokeAfter: cfg.PULSE?.pokeAfterSeconds ?? 480 });
  const raised = pulseAlerts({ now, lastPulse: Number(last), gap: Number(gap), graceUntil: Number(graceUntil), inGrace });
  if (d.due) {
    if (d.opensGrace) log(`pulse   ${d.silence}s since the last poke, over the ${gap}s gap: this poke opens a grace`);
    await act(ctx, `pulse poke (${d.silence}s silent)`, p, "poke", [], { tier: "urgent" });
  } else log(`pulse   last poke ${d.silence}s ago (gap ${gap}s)${inGrace ? ", IN GRACE" : ""}`);
  for (const a of raised) await ctx.alerts.raise(a.level, a.key, a.msg);
  await ctx.alerts.settle("pulse-", new Set(raised.map((a) => a.key)));
}
