// A paid order's life, from decision to relay. THE RULE: a crash never pays twice.
//
// Every step is written to state/orders.json BEFORE it happens, and the money step is a latch: `paying` is written, with the day's spend,
// before the signed payment leaves. From `paying` on, nothing here can ever post a payment for that order again: a restart only polls it
// (black-box/sender, same latch). A latched order the plane never admits becomes `lost`, raises a critical and HOLDS ALL BUYING until the
// plane admits it after all or the owner clears it (`--clear-lost`): daily caps limit a repeat, but an order in an unknown state is a human's call.
//
//   new -> quoted -> paying -> admitted -> done        the answers are on chain, or settled as failed one by one
//    |       |         \-> lost (hold)      \-> each child: waiting -> relayed | consumed | failed
//    |       |         \-> refused-paid (hold): the plane kept the money and refused the request; buying again could repeat it
//    \-------\-> refused (nothing was paid)
//
// STOP, the daily cap and the balance are re-read at the last moment, right before the latch.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { BigNumber, Contract, utils } from "ethers";
import { act, head, reasonOf } from "./act.mjs";
import { logStep } from "./journal.mjs";
import { preflightAttestation } from "./oracle.mjs";
import { challengeAmount, challengeProblem, IMD, PERMIT2, planeClient, signPayment } from "./x402.mjs";
import { declareShape, isUnreadable, readState, statePath, writeState } from "./state.mjs";

const FILE = "orders.json";
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];

/**
 * Where the payment lives. The plane is paid on Ethereum (a Permit2 signature over mainnet IMD) whichever chain the answer is for. The
 * mainnet keeper reads that on its own chain (ctx.pay unset: unchanged). The 4663 keeper reads it through `ctx.pay.provider` (its mainnet
 * peer) and SENDS NOTHING on mainnet: its one Permit2 approval is made by hand (README), so its nonce journal never meets mainnet.
 */
const payToken = (ctx) => (ctx.pay ? new Contract(IMD, TOKEN_ABI, ctx.pay.provider) : ctx.book.token(IMD));
const SPEND = "imd-spend.json";
const OPEN = new Set(["new", "quoted", "paying", "admitted", "lost"]);
/** Stages that hold ALL buying until a human runs --clear-lost. */
const HOLDS = new Set(["lost", "refused-paid"]);
// "refused": the plane will not sign the answer (a guard miss); "deleted": gone from the plane (plane sync check 2026-11-15).
const FAILED_CHILD = new Set(["disagreed", "blocked", "mismatch", "failed", "expired", "cancelled", "refused", "deleted"]);

/** Throws StateUnreadable when orders.json exists and cannot be read: a paid order it may hold is never read as absent. */
const ordersShape = (v) => (!v || !Array.isArray(v.list) || v.list.some((o) => !o || typeof o.key !== "string" || typeof o.stage !== "string") ? "not { list: [{ key, stage, ... }] }" : null);
declareShape(FILE, ordersShape);
export const loadOrders = () => readState(FILE, { list: [] }).list;
const saveOrders = (list) => writeState(FILE, { list });
const update = (order, fields) => {
  const list = loadOrders();
  const i = list.findIndex((o) => o.key === order.key);
  Object.assign(order, fields);
  if (i >= 0) list[i] = order; else list.push(order);
  saveOrders(list);
  logStep(`order-${fields.stage ?? "update"}`, { key: order.key, purpose: order.purpose, planeOrder: order.planeOrder ?? null, ...(fields.why ? { why: fields.why } : {}) });
};
const finish = (order, stage, why) => {
  update(order, { stage, ...(why ? { why } : {}), doneAt: new Date().toISOString() });
  saveOrders(loadOrders().filter((o) => o.key !== order.key));
};

export const openOrders = (purpose = null) => loadOrders().filter((o) => OPEN.has(o.stage) && (!purpose || o.purpose === purpose));
export const lostOrders = () => loadOrders().filter((o) => HOLDS.has(o.stage));
export function clearLost() {
  const lost = lostOrders();
  for (const o of lost) finish(o, "cleared", "cleared by the owner");
  return lost.length;
}

// ---------------------------------------------------------------- the spend ledger: one UTC day, counted at the latch

const today = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const spendShape = (v) => {
  if (!v || typeof v.day !== "string" || typeof v.imd !== "string" || !/^\d+$/.test(v.imd)) return "not { day, imd }";
  return null;
};
declareShape(SPEND, spendShape);
/** Throws StateUnreadable when imd-spend.json exists and cannot be read: the day's spend is never read as 0. */
export function spentToday(ms = Date.now()) {
  const s = readState(SPEND, null);
  return s?.day === today(ms) ? BigNumber.from(s.imd) : BigNumber.from(0);
}
function recordSpend(amount, ms = Date.now()) {
  writeState(SPEND, { day: today(ms), imd: spentToday(ms).add(amount).toString() });
}

/** Pure: may `cost` be spent today? `reserve` is what must stay free for something more urgent. */
export function spendAllows(spent, cost, capImd, reserve = 0) {
  return BigNumber.from(spent).add(cost).add(reserve).lte(utils.parseEther(String(capImd)));
}

export const costOf = (cfg, questions) => utils.parseEther(String(cfg.IMD?.pricePerQuestion ?? 0.5)).mul(questions);

/**
 * Why no paid order may start now, or null. Every check that costs nothing to make, in one place; the last-moment re-check is `pay`.
 * Lost orders hold everything; so do the kill switch and a plane failing its own requests.
 */
export async function buyHold(ctx, cost, { reserve = 0 } = {}) {
  const { cfg, provider, signer } = ctx;
  if (existsSync(statePath("STOP"))) return "kill switch: state/STOP exists";
  // What was paid and spent must be known: a state file that cannot be read holds everything (audit wave 4, C9).
  let lost, spent;
  try {
    lost = lostOrders();
    spent = spentToday();
  } catch (e) {
    if (!isUnreadable(e)) throw e;
    await ctx.alerts?.raise("critical", "state-unreadable", e.message).catch(() => {});
    return e.message;
  }
  if (lost.length) {
    return lost[0].stage === "lost"
      ? `an earlier paid order was never admitted (${lost[0].planeOrder}): held until it is, or until --clear-lost`
      : `the plane refused a paid order (${lost[0].planeOrder}) and kept the payment: held until --clear-lost`;
  }
  if (!process.env.PLANE_BEARER) return "no PLANE_BEARER in the environment";
  if (!ctx.planeState?.ok) return `plane: ${ctx.planeState?.why ?? "not read"}`;
  if (!spendAllows(spent, cost, cfg.IMD?.dailyCap ?? 5, reserve)) return `the day's cap: ${utils.formatEther(spent)} of ${cfg.IMD?.dailyCap ?? 5} IMD spent${reserve ? `, the rest kept for falls` : ""}`;
  const imd = payToken(ctx);
  if ((await imd.balanceOf(signer.address)).lt(cost)) return `keeper holds under ${utils.formatEther(cost)} IMD${ctx.pay ? " on Ethereum" : ""}`;
  // An answer that cannot be relayed is money burned: the relay needs ETH and a gas price under the ceiling.
  const [eth, gas] = await Promise.all([provider.getBalance(signer.address), provider.getGasPrice()]);
  if (eth.lt(utils.parseEther(String(cfg.MIN_ETH ?? 0.003)))) return "keeper is under its ETH floor: an answer could not be relayed";
  if (gas.gt(utils.parseUnits(String(cfg.MAX_GAS_GWEI ?? 100), "gwei"))) return "gas above the ceiling: an answer could not be relayed";
  return null;
}

/** The one Permit2 approval. Up to IMD.permit2Allowance, never unlimited; true when the allowance covers `cost`. */
export async function ensureAllowance(ctx, cost) {
  const imd = payToken(ctx);
  if ((await imd.allowance(ctx.signer.address, PERMIT2)).gte(cost)) return true;
  if (ctx.pay) {
    // Never a mainnet transaction from a process keeping another chain (one journal per chain per key).
    await ctx.alerts?.raise?.("warn", "feeds-permit2-unapproved", `${ctx.signer.address} has under ${utils.formatEther(cost)} IMD approved to Permit2 on Ethereum: approve it by hand (README "4663")`)?.catch(() => {});
    return false;
  }
  const cap = utils.parseEther(String(ctx.cfg.IMD?.permit2Allowance ?? 30));
  const r = await act(ctx, `approve Permit2 ${utils.formatEther(cap)} IMD`, imd, "approve", [PERMIT2, cap], { tier: "urgent" });
  if (!r.hash) return false;
  return (await imd.allowance(ctx.signer.address, PERMIT2)).gte(cost);
}

// ---------------------------------------------------------------- start and advance

/** `questions`: [{ role, leaf (address), input }]. One question is an oracle.request, more are one oracle.group order. */
export function startOrder(purpose, questions) {
  const action = questions.length > 1 ? "oracle.group" : "oracle.request";
  const input = questions.length > 1 ? { questions: questions.map((q) => q.input) } : questions[0].input;
  const order = {
    key: randomUUID(), purpose, action, input, stage: "new", requestKey: randomUUID(), at: new Date().toISOString(),
    questions: questions.map((q) => ({ role: q.role, leaf: q.leaf })),
  };
  update(order, { stage: "new" });
  return order;
}

const client = (ctx) => ctx.planeClient ?? planeClient(ctx.planeState?.base ?? ctx.cfg.API_BASE, process.env.PLANE_BEARER, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {});

/** The oracle request ids an admission opened, in the order asked, or null if it has none yet. */
export function childrenOf(body) {
  const result = body?.admission?.result ?? body?.request?.admission?.result ?? body?.order?.admission?.result ?? null;
  if (!result) return null;
  if (result.kind === "refused") return { refused: result.problems ?? true };
  if (Array.isArray(result.requests)) return result.requests.map((r) => r.requestId);
  return result.requestId ? [result.requestId] : null;
}

/** Everything open, one step each. Report-only mode opens nothing, so has nothing to advance. */
export async function advanceOrders(ctx) {
  if (!ctx.execute) return;
  for (const o of loadOrders().filter((x) => OPEN.has(x.stage))) {
    try {
      // On through the steps that follow each other at once, so a decision reaches the payment in one pass.
      for (let i = 0; i < 4; i++) {
        const before = o.stage;
        await step(ctx, o);
        if (o.stage === before || !OPEN.has(o.stage)) break;
      }
    } catch (e) {
      ctx.log(`order   ${o.key.slice(0, 8)} ${o.stage}: ${reasonOf(e)}`);
    }
  }
}

async function step(ctx, o) {
  const plane = client(ctx);
  // Nothing was paid yet, and its reason to buy and its guards were read when it was opened: past this it is dropped, and the next round decides afresh.
  if ((o.stage === "new" || o.stage === "quoted") && (Date.now() - Date.parse(o.at)) / 1000 > (ctx.cfg.IMD?.unpaidOrderMaxSeconds ?? 600)) {
    ctx.log(`order   ${o.purpose}: unpaid past its limit, dropped`);
    return finish(o, "stale-unpaid", "the decision is too old to pay for");
  }
  if (o.stage === "new") {
    const q = await plane.quote(o.requestKey, o.action, o.input);
    const id = q.body?.order?.id;
    if (id) return update(o, { stage: "quoted", planeOrder: id });
    if (q.status >= 400 && q.status < 500) {
      await ctx.alerts.raise("critical", `feeds-order-refused-${o.purpose}`, `the plane refused ${o.purpose} at the quote (${q.status}): ${JSON.stringify(q.body).slice(0, 300)}; nothing was paid`);
      return finish(o, "refused", `quote ${q.status}`);
    }
    return ctx.log(`order   ${o.purpose}: quote answered ${q.status}, trying again next round`);
  }
  if (o.stage === "quoted") return pay(ctx, o, plane);
  if (o.stage === "paying" || o.stage === "lost") return awaitAdmission(ctx, o, plane);
  if (o.stage === "admitted") return relayAnswers(ctx, o, plane);
}

async function pay(ctx, o, plane) {
  const { cfg } = ctx;
  const ch = await plane.challenge(o.planeOrder);
  if (ch.status === 410) return update(o, { stage: "new", planeOrder: null, requestKey: randomUUID() }); // the quote expired before we paid: nothing moved
  if (ch.status !== 402) return ctx.log(`order   ${o.purpose}: no payment challenge (${ch.status})`);
  const questions = o.questions.length;
  const problem = challengeProblem(ch.body, questions, utils.parseEther(String(cfg.IMD?.pricePerQuestion ?? 0.5)), cfg.PLANE?.payTo, cfg.PLANE?.maxPermitSeconds);
  if (problem) {
    await ctx.alerts.raise("critical", `feeds-order-refused-${o.purpose}`, `${o.purpose}: ${problem}; nothing was paid`);
    return finish(o, "refused", problem);
  }
  const amount = challengeAmount(ch.body);
  // Only a fall may spend the reserve kept for falls: the last-moment check keeps it for every other order (audit wave 4, P2), as
  // the decision did. Spend can move between the decision and here (up to unpaidOrderMaxSeconds).
  const reserve = o.purpose === "fall" ? BigNumber.from(0) : utils.parseEther(String(cfg.IMD?.reserveForFalls ?? 1));
  const hold = await buyHold(ctx, amount, { reserve });
  if (hold) return ctx.log(`order   ${o.purpose}: held at the last moment: ${hold}`);
  if (!(await ensureAllowance(ctx, amount))) return ctx.log(`order   ${o.purpose}: Permit2 allowance not ready`);
  const { paymentHeader, quoteSignature, nonce, deadline } = await signPayment(ctx.signer, ch.body, cfg.PLANE?.maxPermitSeconds ? { maxPermitSeconds: cfg.PLANE.maxPermitSeconds } : {});
  // THE LATCH. From this write on the money may be gone whatever happens next. The Permit2 nonce and deadline go with it: after the
  // deadline the chain alone can say whether this payment was ever taken (awaitAdmission).
  recordSpend(amount);
  update(o, { stage: "paying", paidAt: new Date().toISOString(), amount: amount.toString(), permitNonce: nonce, permitDeadline: deadline });
  if (ctx.crashAfterLatch) throw new Error("test: crash between the latch and the payment");
  const r = await plane.submit(o.planeOrder, quoteSignature, paymentHeader);
  ctx.log(`order   ${o.purpose}: paid ${utils.formatEther(amount)} IMD, plane says ${r.status}`);
  update(o, { submitStatus: r.status });
}

const PERMIT2_ABI = ["function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)"];

/**
 * What the CHAIN says about an order's signed payment: "taken" (its Permit2 nonce is used), "dead" (at a block past its deadline the
 * nonce is still unused, so it can never be taken), "live" (unused and still takeable), or null (unknown: no nonce recorded, or the
 * read failed). Nonce and deadline are read at ONE block: a block past the deadline settles nothing, so unused there is unused for good.
 */
export async function permitState(ctx, o) {
  if (!o.permitNonce || !o.permitDeadline) return null;
  try {
    const on = ctx.pay?.provider ?? ctx.provider; // the payment's chain (Ethereum), not the answer's
    const { number, now } = await head(on);
    const permit2 = ctx.permit2 ?? new Contract(PERMIT2, PERMIT2_ABI, on);
    const n = BigNumber.from(o.permitNonce);
    const word = BigNumber.from(await permit2.nonceBitmap(ctx.signer.address, n.shr(8), { blockTag: number }));
    if (word.shr(n.and(255).toNumber()).and(1).eq(1)) return "taken";
    return now > Number(o.permitDeadline) ? "dead" : "live";
  } catch {
    return null;
  }
}

async function awaitAdmission(ctx, o, plane) {
  const r = await plane.order(o.planeOrder);
  const kids = childrenOf(r.body);
  if (kids?.refused) {
    await ctx.alerts.raise("critical", `feeds-order-refused-${o.purpose}`, `the plane refused ${o.purpose} AFTER payment (order ${o.planeOrder}), ALL BUYING HELD until --clear-lost: ${JSON.stringify(kids.refused).slice(0, 300)}; a refund is a human's question`);
    return update(o, { stage: "refused-paid", why: "refused after payment" });
  }
  if (kids) {
    const children = kids.map((requestId, i) => ({ requestId, role: o.questions[i].role, leaf: o.questions[i].leaf, state: "waiting" }));
    return update(o, { stage: "admitted", children });
  }
  // Once a payment is signed and handed over, only the CHAIN ends it unpaid (audit wave 4, C8): the plane's 'expired' or
  // 'payment_failed' alone never finishes an order nor lifts a hold. Past the permit's deadline with its nonce unused, nothing was or
  // can be charged, whatever anyone says; a used nonce with the plane calling the order failed is a paid refusal: hold.
  const said = ["payment_failed", "expired"].includes(r.body?.status) ? r.body.status : null;
  if (said || o.stage === "lost") {
    const chain = await permitState(ctx, o);
    if (chain === "dead") {
      await ctx.alerts.raise("warn", `feeds-order-unpaid-${o.purpose}`, `${o.purpose}: order ${o.planeOrder}'s payment expired unused on chain (Permit2 nonce unused past its deadline): nothing was charged${said ? `; the plane says ${said}` : ""}`);
      return finish(o, "unpaid", `permit expired unused${said ? `; plane: ${said}` : ""}`);
    }
    if (chain === "taken" && said) {
      await ctx.alerts.raise("critical", `feeds-order-refused-${o.purpose}`, `the plane calls order ${o.planeOrder} (${o.purpose}) ${said} but its payment WAS taken on chain: ALL BUYING HELD until --clear-lost`);
      return update(o, { stage: "refused-paid", why: `paid on chain, plane says ${said}` });
    }
    if (said) ctx.log(`order   ${o.purpose}: the plane says ${said}; the chain says ${chain ?? "nothing readable"}: waiting for the permit's deadline`);
  }
  const waited = (Date.now() - Date.parse(o.paidAt)) / 1000;
  if (o.stage === "paying" && waited > (ctx.cfg.IMD?.admissionTimeoutSeconds ?? 3600)) {
    await ctx.alerts.raise("critical", `feeds-order-lost`, `order ${o.planeOrder} (${o.purpose}) was paid ${Math.round(waited / 60)} min ago and never admitted: ALL BUYING HELD until it is, or --clear-lost`);
    update(o, { stage: "lost" });
  }
}

async function relayAnswers(ctx, o, plane) {
  const { book, provider } = ctx;
  for (const c of o.children.filter((x) => x.state === "waiting")) {
    const leaf = book.leaf(c.leaf);
    const att = await plane.attestation(c.requestId);
    if (att.status !== 200 || !att.body?.message) {
      const st = await plane.oracleRequest(c.requestId);
      if (FAILED_CHILD.has(st.body?.status)) {
        await ctx.alerts.raise("warn", `feeds-answer-failed-${c.role}`, `${c.role}: the panel ended ${st.body.status} (request ${c.requestId}); 0.5 IMD spent, no answer`);
        Object.assign(c, { state: "failed", why: st.body.status });
        update(o, {});
      } else if ((Date.now() - Date.parse(o.paidAt)) / 1000 > (ctx.cfg.IMD?.answerTimeoutSeconds ?? 3 * 3600)) {
        await ctx.alerts.raise("warn", `feeds-answer-failed-${c.role}`, `${c.role}: no answer ${ctx.cfg.IMD?.answerTimeoutSeconds ?? 3 * 3600}s after payment (request ${c.requestId})`);
        Object.assign(c, { state: "failed", why: "timed out" });
        update(o, {});
      }
      continue;
    }
    const pf = await preflightAttestation(provider, leaf, att.body, { evmHead: ctx.evmHead ?? null });
    if (pf.consumed) {
      Object.assign(c, { state: "consumed" });
      update(o, {});
      continue;
    }
    if (pf.fail.length) {
      ctx.log(`relay   ${c.role}: would revert: ${pf.fail.join("; ")}`);
      if (pf.terminal) {
        await ctx.alerts.raise("warn", `feeds-answer-failed-${c.role}`, `${c.role}: answer cannot be relayed: ${pf.fail.join("; ")}`);
        Object.assign(c, { state: "failed", why: pf.fail[0] });
        update(o, {});
      }
      continue;
    }
    const r = await act(ctx, `relay ${c.role} ${c.requestId.slice(0, 8)} = ${pf.value}`, leaf, "submitAttestation", [pf.tuple, pf.signature], { tier: "urgent" });
    if (r.hash) {
      Object.assign(c, { state: "relayed", hash: r.hash, value: pf.value.toString() });
      update(o, {});
    }
  }
  if (o.children.every((c) => c.state !== "waiting")) finish(o, "done");
}
