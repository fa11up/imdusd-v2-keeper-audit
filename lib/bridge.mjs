// The bridge watcher (src/bridge/ImdBridge.sol in the audit snapshot; the hold design and the inbound delay, no guardian). ALERT-ONLY, with
// ONE send: there is no guardian; only the chain's Safe pauses, holds, voids or cancels. This is the one detector of a
// forgery once the guardian key is gone, so every check here is a CRITICAL alert for the Safe signers. The one transaction it sends is
// `claim` of an HONEST queued transfer on its own chain (AUTO-CLAIM below): anyone may send it, it gives the keeper no right.
//
// WHAT IT PROVES, per direction A -> B (A = where imdUSD is burned and `Sent`, B = where it is minted and `Received`):
//   FORGED.  Every `Received(guid, srcEid = A, to, amount, nonce)` on B has a `Sent(guid, dstEid = B, from, to, amount, nonce)` on A with the
//            same guid, recipient and amount. A Received whose nonce has no Sent on A, once A has been read past the Received, or whose
//            Sent differs, is a forgery: critical `bridge-forged-*`. Also the counters: B.received() <= A.sent(), B read first.
//   ONE CLOCK (fixed before audit wave 5). Timestamps of the two chains are NEVER compared: 4663's sequencer clock may run ahead of or behind
//            L1's. "A read past the Received" is measured in A's OWN BLOCKS: when a Received is first indexed on B, A's head is read
//            AFTER that read (`srcBound`); a Sent always precedes its Received in real time, so an honest Sent is at or below that
//            head, and once A is indexed through `srcBound` its absence proves a forgery. (Wave-5 audit #1: the head is read only once
//            `peerLagSeconds` of the keeper's OWN clock have passed since the Received was first indexed, and is the highest of A's
//            RPCs: a source node lagging up to that long plus the delivery time cannot make an honest transfer look forged.) That is the next pass (A's log lag is 3
//            blocks); if A cannot be read that far, the Received is `bridge-unverified-*` after `unverifiedSeconds` (30 min) measured
//            in B's clock alone (B's read time minus the Received's B time). STUCK ages use A's clock alone (A's head time read
//            BEFORE B is indexed, minus the Sent's A time).
//   COMPLETE LOGS (fixed before audit wave 5). A range is marked read only when two reads agree AND the bridge's own `sent`/`received`
//            counters at the block read through equal the last proven counters plus the range's Sent/Received amounts (indexSide). An
//            RPC answering [] for a range with events cannot move the cursor past it: `bridge-index-gap-*` (critical after 30 min).
//            DelaySet moves no counter, so the path's settings are proven the same way: the delay and cutoff the index would hold
//            after the range must equal `breakers(srcEid)` read at the block read through.
//   VERIFIED, NOT YET RUN (fixed before audit wave 5). `Received` is emitted AFTER the mint, and hold/voidPayload stop only a packet the
//            endpoint has verified that has not run yet. So the watcher also reads B's EndpointV2 `PacketVerified` for our bridge: a
//            verified payload hash that matches no Sent at that nonce on A (same one-clock rule) is critical
//            `bridge-verified-forged-*`, and while EndpointV2.inboundPayloadHash still holds it the alert says it has NOT executed:
//            the Safe can hold(srcEid, nonce) or voidPayload(hash) before it runs. THE WINDOW EXISTS ONLY WHEN THE PACKET CANNOT RUN AT
//            ONCE: lzReceive reverts (path paused, inbound limit spent, under MIN_AMOUNT, a hold, an unconfigured library) or nobody
//            has run it yet. lzReceive is permissionless: a forger who verifies and executes in one block (or one transaction) leaves
//            no block the watcher can read, and the forgery is seen only from its Received, after the mint.
//   STUCK.   A Sent not Received on B `stuckWarnSeconds` (30 min) after it (A's clock): warn; `stuckCriticalSeconds` (2 h): critical,
//            unless the Safe holds it (reported as held) or voided it.
//   HELD / VOIDED / PAUSED. Every HoldPlaced (until released, or expired and delivered), every Voided payload hash (until Unvoided; matched
//            to its Sent when it is one: an honest transfer voided means burned funds that cannot arrive), every paused path: critical.
//   QUEUED (the ImdBridge inbound delay). A transfer over the path's instant allowance does not mint:
//            B emits `Queued(guid, srcEid, to, amount, nonce, claimableAt)` and anyone may `claim` it once B's clock passes queuedAt +
//            the path's delay AT CLAIM TIME (`breakers(srcEid).delay`, 12 h at launch; the Safe may lengthen it at once or shorten it
//            after the timelock, and either applies to pending claims: Queued's claimableAt is only the delay at queue time). A
//            bulk-cancel cutoff (`breakers(srcEid).cancelledFrom`) refuses every claim queued at or after it until a SET_DELAY lifts
//            it. Both are set through DelaySet, indexed with the bridge's other logs. `received` moves at the claim (`Claimed`),
//            `queued` holds what waits. A Queued is judged exactly like a
//            Received (same Sent match, same one-clock rule): no match is critical `bridge-queued-forged-*` naming the Safe's calls on B
//            (pause(srcEid), cancelClaim(srcEid, guid)), raised long before claimableAt: the Safe's window. The counters prove Queued,
//            Claimed, ClaimCancelled and ClaimRestored too (`queued` = proven + Queued - Claimed - cancelled + restored).
//   AUTO-CLAIM. On ITS OWN chain only (the keeper holds no key for the peer), each pending
//            queued transfer that MATCHES its Sent exactly (guid, nonce, amount, recipient) is claimed in the first pass after B's
//            clock passes queuedAt + the delay read THIS pass, while the path is open: not paused, and its queue breaker not tripped
//            (`breakers(srcEid)`; a simulation refusal PathPaused/Tripped is read the same way; unreadable = closed). A claim the
//            bulk cutoff covers is held: no send, no warning (info `bridge-bulk-cancel-*` while a cutoff is set); lifted, it is
//            claimed like any other. Urgent tier from maturity (wave-5 audit #17;
//            `claimUrgentSeconds` > 0 restores a routine first period). NEVER an unmatched or unjudged one: the forged alert speaks
//            and the Safe acts (the keeper is not the defence: a forger can claim his own after 12 h). No double send: a claim whose
//            send is open in the send journal (or its cancel) waits; one the journal shows mined is done; the chain's own `claims()`
//            state is read before each send and the send simulates first. Report-only mode simulates and sends nothing (lib/act.mjs).
//   SUPPLY.  On each chain read: totalSupply == sum(ilk debt) + sum(ilk bad debt) + reserveBacked + migrator outstanding + peg keeper
//            outstanding + bridge.received - bridge.sent (Ledger SUPPLY invariant), at one block. It cannot see a forgery (a forged mint
//            counts as received), only accounting drift: critical past BRIDGE_WATCH.supplyToleranceWei.
// SIDES. The watcher reads its home chain (ctx.provider, book.bridge) and the peer (ctx.peers[peerChainId], BRIDGE_WATCH.peer.bridge). By
// default it checks BOTH directions, so one process covers the bridge; run it in both keepers and each still alerts on its own copy.
//
// PAGING: the Safe signers are to be paged on every critical alert here. NOT BUILT: today
// these go through lib/alerts.mjs, which sends to TELEGRAM_CHAT_ID when configured. Paging the signers goes where `page()` is called below.
import { existsSync, readFileSync } from "node:fs";
import { BigNumber, Contract, utils } from "ethers";
import { act, withSendLock } from "./act.mjs";
import { pendingIntents, settleIntents } from "./journal.mjs";
import { BRIDGE_ABI, chainOfEid, EID, ENDPOINT_ABI, LEDGER_4663_ABI, SUPPLY_ABI } from "./robinhood.mjs";
import { PARAMS_ABI, PEG_HOOK_ABI } from "./deployment.mjs";
import { readStateOr, statePath, writeState } from "./state.mjs";

const lc = (a) => String(a).toLowerCase();
const CONVERSION = BigNumber.from(10).pow(12);

/** The LayerZero payload hash ImdBridge voids and holds by: keccak(guid ‖ to ‖ uint64 amountSD) (OFTMsgCodec with no compose). */
export const payloadHashOf = ({ guid, to, amount }) => utils.solidityKeccak256(["bytes32", "bytes32", "uint64"], [guid, utils.hexZeroPad(to, 32), BigNumber.from(amount).div(CONVERSION)]);

const recipientOf = (to) => lc(utils.hexDataSlice(utils.hexZeroPad(to, 32), 12));

/** An empty index of one chain's bridge events. */
export const emptySide = (next) => ({ next, start: next, throughBlock: next - 1, throughTime: 0, sent: {}, received: {}, holds: {}, voids: {}, verified: {}, queue: {}, claimKey: {}, other: [] });

const CLAIM_STATE = { 2: "claimed", 3: "cancelled" };

/** Pure: fold parsed bridge events (with `time`) into a side's index. */
export function addEvents(side, events) {
  for (const e of events) {
    const n = e.args?.nonce !== undefined ? String(e.args.nonce) : null;
    if (e.name === "Sent") side.sent[`${e.args.dstEid}:${n}`] = { guid: lc(e.args.guid), to: lc(e.args.to), amount: e.args.amount.toString(), block: e.blockNumber, time: e.time, tx: e.transactionHash };
    else if (e.name === "Received") side.received[`${e.args.srcEid}:${n}`] = { guid: lc(e.args.guid), to: lc(e.args.to), amount: e.args.amount.toString(), block: e.blockNumber, time: e.time, tx: e.transactionHash };
    else if (e.name === "HoldPlaced") side.holds[`${e.args.srcEid}:${n}`] = { payloadHash: lc(e.args.payloadHash), until: Number(e.args.until), released: false };
    else if (e.name === "HoldReleased") (side.holds[`${e.args.srcEid}:${n}`] ??= { payloadHash: lc(e.args.payloadHash), until: 0 }).released = true;
    else if (e.name === "Voided") side.voids[lc(e.args.payloadHash)] = { at: e.time, kind: Number(e.args.kind) };
    else if (e.name === "Unvoided") delete side.voids[lc(e.args.payloadHash)];
    else if (e.name === "Queued") {
      const key = `${e.args.srcEid}:${n}`;
      // queuedAt = the block's time (ImdBridge stores block.timestamp); claimableAt = the delay at queue time, for reference only.
      (side.queue ??= {})[key] = { guid: lc(e.args.guid), to: lc(e.args.to), amount: e.args.amount.toString(), queuedAt: e.time, claimableAt: Number(e.args.claimableAt), state: "pending", block: e.blockNumber, time: e.time, tx: e.transactionHash };
      (side.claimKey ??= {})[`${e.args.srcEid}:${lc(e.args.guid)}`] = key;
    } else if (e.name === "Claimed" || e.name === "ClaimCancelled" || e.name === "ClaimRestored") {
      const q = side.queue?.[side.claimKey?.[`${e.args.srcEid}:${lc(e.args.guid)}`]];
      if (q) {
        q.state = e.name === "Claimed" ? "claimed" : e.name === "ClaimCancelled" ? "cancelled" : "pending";
        if (e.name === "Claimed") q.claimedTx = e.transactionHash;
      } else (side.other ??= []).push({ name: e.name, srcEid: Number(e.args.srcEid), guid: lc(e.args.guid), block: e.blockNumber }); // its Queued is before fromBlock
    } else if (e.name === "DelaySet") {
      (side.delays ??= {})[String(e.args.srcEid)] = { instantCap: e.args.instantCap.toString(), delay: Number(e.args.delay), queueBreaker: e.args.queueBreaker.toString(), cancelFrom: Number(e.args.cancelFrom), block: e.blockNumber, tx: e.transactionHash };
    } else if (e.name === "PacketVerified") {
      const v = ((side.verified ??= {})[`${e.args.origin.srcEid}:${String(e.args.origin.nonce)}`] ??= {});
      v[lc(e.args.payloadHash)] ??= { sender: lc(e.args.origin.sender), block: e.blockNumber, time: e.time, tx: e.transactionHash };
    }
  }
  return side;
}

/**
 * Pure: the alerts for one direction. `src` = the side that sends to `dst`; `srcEid`/`dstEid` their endpoint ids; `now` = dst's read
 * time (DST's clock); `srcNow` = a src head time read before dst was indexed (SRC's clock; default src.throughTime). A Received is judged
 * only once `src` has been indexed through its `srcBound` (src's head read after the Received was): else it is `unverified`, alerted
 * only if that lasts `unverifiedSeconds` in dst's clock. No timestamp of one chain is ever compared with the other's.
 */
export function matchDirection({ src, dst, srcEid, dstEid, now, srcNow = src.throughTime, srcName, dstName, stuckWarnSeconds = 1800, stuckCriticalSeconds = 7200, unverifiedSeconds = 1800 }) {
  const out = [];
  const forged = [];
  for (const [key, r] of Object.entries(dst.received)) {
    const [eid, nonce] = key.split(":");
    if (Number(eid) !== Number(srcEid)) {
      forged.push(nonce);
      out.push({ level: "critical", key: `bridge-forged-${dstName}-eid${eid}-${nonce}`, msg: `${dstName} Received ${utils.formatEther(r.amount)} imdUSD to ${r.to} from endpoint ${eid}, which is not the peer (${srcEid}) (tx ${r.tx})` });
      continue;
    }
    const s = src.sent[`${dstEid}:${nonce}`];
    if (s) {
      if (s.guid !== r.guid || s.amount !== r.amount || recipientOf(s.to) !== lc(r.to)) {
        forged.push(nonce);
        out.push({ level: "critical", key: `bridge-forged-${dstName}-${nonce}`, msg: `${dstName} Received nonce ${nonce} (${utils.formatEther(r.amount)} to ${r.to}, guid ${r.guid}) does NOT match ${srcName}'s Sent at that nonce (${utils.formatEther(s.amount)} to ${recipientOf(s.to)}, guid ${s.guid}): FORGED. Safe: pause the path on ${srcName} and ${dstName}, void what is waiting; VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void (tx ${r.tx})` });
      }
      continue;
    }
    if (r.srcBound !== undefined && src.throughBlock >= r.srcBound) {
      forged.push(nonce);
      out.push({ level: "critical", key: `bridge-forged-${dstName}-${nonce}`, msg: `${dstName} Received ${utils.formatEther(r.amount)} imdUSD to ${r.to} at nonce ${nonce} and ${srcName} never Sent that nonce (read through block ${src.throughBlock}): FORGED. Safe: pause both paths now, void every waiting forged payload; VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void (tx ${r.tx})` });
    } else if (now - r.time > unverifiedSeconds) {
      out.push({ level: "critical", key: `bridge-unverified-${dstName}-${nonce}`, msg: `${dstName} Received nonce ${nonce} ${now - r.time}s ago and ${srcName} has not been read past it (through ${src.throughBlock}, needs ${r.srcBound ?? "a read after it"}): the watcher cannot prove it honest` });
    }
  }
  // Queued transfers (inbound delay): judged like a Received, before anything is minted. The Safe's window is until claimableAt.
  // The bulk cutoff named in every forged-Queued alert is the FIRST forged pending Queued's time on that path (a review before wave 5b: a cutoff
  // after it lets the earlier forged claims through).
  const firstForged = {};
  for (const [key, q] of Object.entries(dst.queue ?? {})) {
    const [eid, nonce] = key.split(":");
    if (q.state !== "pending") continue;
    const jj = Number(eid) !== Number(srcEid) ? { verdict: "forged" } : judgeQueued(q, nonce, src, dstEid);
    if (jj.verdict === "forged") firstForged[eid] = Math.min(firstForged[eid] ?? Infinity, q.queuedAt ?? q.time);
  }
  for (const [key, q] of Object.entries(dst.queue ?? {})) {
    const [eid, nonce] = key.split(":");
    const j = Number(eid) !== Number(srcEid) ? { verdict: "forged" } : judgeQueued(q, nonce, src, dstEid);
    // Claimable at queuedAt + the delay in force (the last DelaySet indexed; Queued's own claimableAt before any).
    const queuedAt = q.queuedAt ?? q.time;
    const d = dst.delays?.[String(eid)];
    const at = new Date((queuedAt + (d ? d.delay : q.claimableAt - queuedAt)) * 1000).toISOString();
    const cut = d && d.cancelFrom !== 0 && queuedAt >= d.cancelFrom;
    const calls = `Safe on ${dstName}: pause(${eid}) on the ${dstName} bridge NOW (stops every claim on the path), then cancelClaim(${eid}, ${q.guid}); or tighten(${eid}, <cap>, <delay>, <breaker>, ${firstForged[eid] ?? queuedAt}) to cancel every claim queued since the FIRST forged one, in one act${cut ? ` (a cutoff at ${d.cancelFrom} already holds it)` : ""}; then the VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void`;
    if (j.verdict === "forged") {
      forged.push(nonce);
      const what = j.sent ? `${srcName} Sent a DIFFERENT transfer at that nonce (${utils.formatEther(j.sent.amount)} to ${recipientOf(j.sent.to)}, guid ${j.sent.guid})` : Number(eid) !== Number(srcEid) ? `endpoint ${eid} is not the peer (${srcEid})` : `${srcName} never Sent that nonce (read through block ${src.throughBlock})`;
      if (q.state === "pending") out.push({ level: "critical", key: `bridge-queued-forged-${dstName}-${nonce}`, msg: `${dstName} QUEUED a FORGED claim: ${utils.formatEther(q.amount)} imdUSD to ${q.to} at nonce ${nonce}, guid ${q.guid} (tx ${q.tx}); ${what}. NOT MINTED YET: anyone can claim it from ${at} (${dstName} clock). ${calls}` });
      else if (q.state === "claimed") out.push({ level: "critical", key: `bridge-queued-forged-${dstName}-${nonce}`, msg: `${dstName}: a FORGED queued claim was CLAIMED (minted ${utils.formatEther(q.amount)} imdUSD to ${q.to}, nonce ${nonce}, claim tx ${q.claimedTx}); ${what}. Safe: pause both paths` });
      else out.push({ level: "warn", key: `bridge-queued-forged-${dstName}-${nonce}`, msg: `${dstName}'s Safe cancelled a forged queued claim (nonce ${nonce}, ${utils.formatEther(q.amount)} imdUSD, guid ${q.guid}); ${what}` });
    } else if (j.verdict === "unjudged") {
      if (now - q.time > unverifiedSeconds) out.push({ level: "critical", key: `bridge-queued-unverified-${dstName}-${nonce}`, msg: `${dstName} queued a claim at nonce ${nonce} (${utils.formatEther(q.amount)} imdUSD to ${q.to}, claimable from ${at}) ${now - q.time}s ago and ${srcName} has not been read past it (through ${src.throughBlock}, needs ${q.srcBound ?? "a read after it"}): the watcher cannot prove it honest, and does not claim it. If ${srcName} stays unreadable: ${calls}` });
    } else if (q.state === "cancelled") {
      out.push({ level: "critical", key: `bridge-cancelled-honest-${dstName}-${nonce}`, msg: `${dstName}'s Safe CANCELLED an honest queued transfer: ${srcName} Sent ${utils.formatEther(q.amount)} imdUSD to ${q.to} at nonce ${nonce} (burned there). It never arrives until the timelock's UNCANCEL(${eid}, ${q.guid}) (48 h)` });
    }
  }
  for (const [key, s] of Object.entries(src.sent)) {
    const [eid, nonce] = key.split(":");
    if (Number(eid) !== Number(dstEid)) continue;
    if (dst.received[`${srcEid}:${nonce}`]) continue;
    if (dst.queue?.[`${srcEid}:${nonce}`]) continue; // delivered as a claim: judged above, claimed by the auto-claim duty
    const hash = payloadHashOf(s);
    const hold = dst.holds[`${srcEid}:${nonce}`];
    if (dst.voids[hash]) {
      out.push({ level: "critical", key: `bridge-voided-honest-${dstName}-${nonce}`, msg: `${dstName}'s Safe VOIDED the payload of an honest transfer: ${srcName} Sent ${utils.formatEther(s.amount)} imdUSD at nonce ${nonce} (tx ${s.tx}), burned there, and it can never arrive until UNVOID (48 h)` });
      continue;
    }
    if (hold && !hold.released) {
      out.push({ level: "critical", key: `bridge-held-${dstName}-${nonce}`, msg: `${dstName}'s Safe holds nonce ${nonce} from ${srcName} (${utils.formatEther(s.amount)} imdUSD) until ${new Date(hold.until * 1000).toISOString()}${hold.payloadHash === hash ? "" : `; the held payload ${hold.payloadHash} is NOT the Sent one ${hash}`}: when the hold ends it QUEUES for the path's delay D (a hold is only a delay), then anyone may claim it` });
      continue;
    }
    if (dst.gapSince !== undefined) continue; // dst's logs are unproven past its cursor: the gap alert speaks, not a stuck guess
    const age = srcNow - s.time; // src's clock only
    if (age >= stuckCriticalSeconds) out.push({ level: "critical", key: `bridge-stuck-${srcName}-${nonce}`, msg: `${srcName} Sent ${utils.formatEther(s.amount)} imdUSD at nonce ${nonce} ${Math.round(age / 60)} min ago and ${dstName} has not received it (tx ${s.tx}): DVNs, executor, a paused path or an inbound limit` });
    else if (age >= stuckWarnSeconds) out.push({ level: "warn", key: `bridge-stuck-${srcName}-${nonce}`, msg: `${srcName} Sent nonce ${nonce} (${utils.formatEther(s.amount)} imdUSD) ${Math.round(age / 60)} min ago, not yet received on ${dstName}` });
  }
  // Holds and voids that match nothing we sent: a held or voided forgery, i.e. the Safe acting on one. Still critical while it stands.
  for (const [key, h] of Object.entries(dst.holds)) {
    const [eid, nonce] = key.split(":");
    if (h.released || dst.received[key] || dst.queue?.[key] || src.sent[`${dstEid}:${nonce}`]) continue;
    const twin = Object.entries(src.sent).find(([k, x]) => Number(k.split(":")[0]) === Number(dstEid) && lc(payloadHashOf(x)) === lc(h.payloadHash));
    if (twin) { // a held REPLAY of an honest transfer: the nonce-scoped response, never a void by hash
      out.push({ level: "critical", key: `bridge-held-${dstName}-${nonce}`, msg: `${dstName}'s Safe holds a REPLAY at nonce ${nonce}: payload ${h.payloadHash} is ${srcName}'s honest transfer at nonce ${twin[0].split(":")[1]}. Do NOT void it (a void is by hash). RELEASE(${eid}, ${nonce}, 0), a DROP, proposed within 24 h of the hold: it never runs at that nonce; the honest twin runs` });
      continue;
    }
    out.push({ level: "critical", key: `bridge-held-${dstName}-${nonce}`, msg: `${dstName}'s Safe holds a payload at nonce ${nonce} from endpoint ${eid} that ${srcName} never sent (${h.payloadHash}): a forgery under hold until ${new Date(h.until * 1000).toISOString()}: voidPayload(${h.payloadHash}) before then (when the hold ends it QUEUES for D and its claim must be cancelled within D)` });
  }
  const sentHashes = new Set(Object.entries(src.sent).filter(([k]) => Number(k.split(":")[0]) === Number(dstEid)).map(([, s]) => payloadHashOf(s)));
  for (const hash of Object.keys(dst.voids)) {
    if (sentHashes.has(hash)) continue;
    out.push({ level: "warn", key: `bridge-voided-${dstName}-${hash.slice(0, 18)}`, msg: `${dstName}'s Safe voided payload ${hash}, which matches nothing ${srcName} sent (a forgery refused for good)` });
  }
  return { alerts: out, forged };
}

/**
 * The alerts for packets VERIFIED at dst's endpoint. A verified payload hash at (srcEid, nonce) from our peer bridge on src
 * that matches neither the Received that ran at that nonce nor src's Sent at that nonce is forged, judged by the same one-clock rule
 * as a Received (src indexed through its `srcBound`; a Sent at that nonce with another hash is judged at once). `readStored(srcEid,
 * sender, nonce)` reads EndpointV2.inboundPayloadHash now (null if unreadable): while it still holds the forged hash the packet has
 * NOT run, and the alert says the Safe can still hold or void it.
 */
export async function verifiedAlerts({ src, dst, srcEid, dstEid, srcBridge, now, srcName, dstName, unverifiedSeconds = 1800, readStored }) {
  const out = [];
  const peer = lc(utils.hexZeroPad(srcBridge, 32));
  for (const [key, byHash] of Object.entries(dst.verified ?? {})) {
    const [eid, nonce] = key.split(":");
    if (Number(eid) !== Number(srcEid)) continue;
    const ran = dst.received[key] ?? dst.queue?.[key]; // a queued one ran too: its Queued is judged by matchDirection
    const s = src.sent[`${dstEid}:${nonce}`];
    for (const [hash, v] of Object.entries(byHash)) {
      if (v.sender !== peer) continue; // not our peer: lzReceive refuses it (OnlyPeer), it can never mint
      if (ran && lc(payloadHashOf(ran)) === hash) continue; // it ran: its Received is judged by matchDirection
      if (s && lc(payloadHashOf(s)) === hash) continue; // honest
      if (dst.voids[hash]) continue; // voided for good: the voided-payload warning speaks for it
      const judged = !!s || (v.srcBound !== undefined && src.throughBlock >= v.srcBound);
      if (!judged) {
        if (now - v.time > unverifiedSeconds) out.push({ level: "critical", key: `bridge-verified-unverified-${dstName}-${nonce}`, msg: `${dstName}'s endpoint verified payload ${hash} at nonce ${nonce} ${now - v.time}s ago and ${srcName} has not been read past it (through ${src.throughBlock}): the watcher cannot prove it honest` });
        continue;
      }
      // A REPLAY (a review before wave 5b): the forged hash is an honest Sent's at ANOTHER nonce (same guid and message). A void is by
      // hash on every nonce and path, so voiding it would refuse the honest twin too: the response is nonce-scoped (README, wave 5b).
      const twin = Object.entries(src.sent).find(([k, x]) => Number(k.split(":")[0]) === Number(dstEid) && k.split(":")[1] !== String(nonce) && lc(payloadHashOf(x)) === hash);
      if (twin) {
        const m = twin[0].split(":")[1];
        out.push({ level: "critical", key: `bridge-verified-replay-${dstName}-${nonce}`, msg: `${dstName}'s endpoint verified a REPLAY at nonce ${nonce} from endpoint ${eid}: payload ${hash} is ${srcName}'s honest transfer at nonce ${m} (${utils.formatEther(twin[1].amount)} imdUSD to ${recipientOf(twin[1].to)}), tx ${v.tx}. Do NOT voidPayload(${hash}): a void is by hash and would refuse the honest transfer too. Safe on ${dstName}: hold(${eid}, ${nonce}) NOW, then RELEASE(${eid}, ${nonce}, 0), a DROP (proposed within 24 h of the hold: 72 h less the 48 h timelock): the held payload never runs at that nonce, any other payload there runs as a claim; the honest twin mints` });
        continue;
      }
      const why = s ? `${srcName} Sent a DIFFERENT payload at that nonce (${payloadHashOf(s)}, ${utils.formatEther(s.amount)} imdUSD to ${recipientOf(s.to)}): a forgery over an honest transfer` : `${srcName} never sent that nonce (read through block ${src.throughBlock})`;
      const stored = ran ? lc(utils.hexZeroPad("0x", 32)) : await readStored(Number(eid), v.sender, Number(nonce)).catch(() => null);
      if (stored !== null && lc(stored) === hash) {
        out.push({ level: "critical", key: `bridge-verified-forged-${dstName}-${nonce}`, msg: `${dstName}'s endpoint holds a FORGED packet for our bridge at nonce ${nonce} from endpoint ${eid}, verified (tx ${v.tx}) and NOT YET EXECUTED: it waits at the endpoint. ${why}. Safe on ${dstName}: voidPayload(${hash}) NOW, then pause the path on both chains (a hold only DELAYS it: when the hold ends it QUEUES for the path's delay D and its claim must then be cancelled within D). Anyone may run it the moment it can execute. VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void` });
      } else if (stored === null) {
        out.push({ level: "critical", key: `bridge-verified-forged-${dstName}-${nonce}`, msg: `${dstName}'s endpoint verified a FORGED packet for our bridge at nonce ${nonce} (payload ${hash}, tx ${v.tx}); whether it still waits there could not be read. ${why}. Safe on ${dstName}: voidPayload(${hash}) and pause both paths; VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void` });
      } else if (!ran) {
        out.push({ level: "warn", key: `bridge-verified-forged-${dstName}-${nonce}`, msg: `${dstName}'s endpoint verified a FORGED packet for our bridge at nonce ${nonce} (payload ${hash}, tx ${v.tx}); the endpoint no longer stores it (overwritten, nilified, burned, or it just ran: a Received alert follows if so). ${why}` });
      }
    }
  }
  return out;
}

/**
 * Pure: is the queued claim `q` at (srcEid, `nonce`) on dst the transfer `src` Sent? "honest" only when src's Sent at that nonce has the
 * same guid, amount and recipient; "forged" when it differs, or when src is indexed through the claim's `srcBound` with no Sent there
 * (one-clock rule, as for a Received); else "unjudged". Only "honest" is ever claimed.
 */
export function judgeQueued(q, nonce, src, dstEid) {
  const s = src.sent[`${dstEid}:${nonce}`];
  if (s) return s.guid === q.guid && s.amount === q.amount && recipientOf(s.to) === lc(q.to) ? { verdict: "honest", sent: s } : { verdict: "forged", sent: s };
  if (q.srcBound !== undefined && src.throughBlock >= q.srcBound) return { verdict: "forged" };
  return { verdict: "unjudged" };
}

/** Pure: the cumulative counters. `dstReceived` then `dstQueued` read BEFORE `srcSent`, so an honest bridge always has
 *  dstReceived + dstQueued <= srcSent (a claim moves an amount from queued to received: read in that order it is never counted twice). */
export function counterAlerts({ dstReceived, dstQueued = 0, srcSent, srcName, dstName }) {
  const r = BigNumber.from(dstReceived).add(dstQueued), s = BigNumber.from(srcSent);
  if (r.gt(s)) return [{ level: "critical", key: `bridge-counters-${dstName}`, msg: `${dstName} bridge received + queued ${utils.formatEther(r)} imdUSD in total, more than ${srcName} ever sent (${utils.formatEther(s)}): ${utils.formatEther(r.sub(s))} minted or queued without a burn. Safe: pause both paths` }];
  return [];
}

/** Pure: the supply equation. All terms read at one block of one chain. Returns { diff, alert }. */
export function supplyCheck({ totalSupply, debts, badDebts, reserveBacked, migrator, pegKeeper, received, sent, toleranceWei = 10n ** 18n, name }) {
  const sum = (xs) => xs.reduce((a, x) => a.add(x), BigNumber.from(0));
  const rhs = sum(debts).add(sum(badDebts)).add(reserveBacked).add(migrator).add(pegKeeper).add(received).sub(sent);
  const diff = BigNumber.from(totalSupply).sub(rhs);
  const abs = diff.abs();
  const alert = abs.gt(BigNumber.from(toleranceWei))
    ? { level: "critical", key: `bridge-supply-${name}`, msg: `${name}: imdUSD totalSupply ${utils.formatEther(totalSupply)} != debt + bad debt + reserveBacked + migrator + peg keeper + bridge received - sent (${utils.formatEther(rhs)}), off by ${utils.formatEther(diff)}` }
    : null;
  return { diff, alert };
}

/** What two log answers must agree on (nodes add extras such as blockTimestamp). */
const logId = (l) => JSON.stringify([Number(l.blockNumber), Number(l.logIndex), String(l.transactionHash).toLowerCase(), l.topics, l.data]);

/**
 * One range's logs, read until the LAST TWO reads agree and no earlier read saw a log they lack (fixed before audit wave 5): a node that
 * answers [] for a range holding events is outvoted by the read that saw them. Null if `maxReads` reads never settle.
 */
export async function readAgreed(provider, filter, maxReads = 4) {
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < maxReads; i++) {
    const logs = await provider.getLogs(filter);
    const ids = logs.map(logId);
    for (const id of ids) seen.add(id);
    const k = ids.join("|");
    if (prev !== null && k === prev && ids.length === seen.size) return logs;
    prev = k;
  }
  return null;
}

/**
 * Pure: what the parsed events move the bridge's counters by. `sent` by Sent, `received` by Received AND Claimed (a queued transfer
 * counts at its claim), `queued` by + Queued - Claimed - ClaimCancelled + ClaimRestored. A cancel or restore carries no amount: it is
 * the amount of its Queued, from these events or `side`'s index; `queued` is null when one cannot be found (Queued before fromBlock).
 */
export function totalsOf(events, side = null) {
  let sent = BigNumber.from(0), received = BigNumber.from(0), queued = BigNumber.from(0);
  const amounts = new Map();
  for (const q of Object.values(side?.queue ?? {})) amounts.set(`${q.guid}`, q.amount);
  let known = true;
  for (const e of events) {
    if (e.name === "Sent") sent = sent.add(e.args.amount);
    else if (e.name === "Received") received = received.add(e.args.amount);
    else if (e.name === "Queued") {
      queued = queued.add(e.args.amount);
      amounts.set(lc(e.args.guid), e.args.amount.toString());
    } else if (e.name === "Claimed") {
      received = received.add(e.args.amount);
      queued = queued.sub(e.args.amount);
    } else if (e.name === "ClaimCancelled" || e.name === "ClaimRestored") {
      const a = amounts.get(lc(e.args.guid));
      if (a === undefined) known = false;
      else queued = e.name === "ClaimCancelled" ? queued.sub(a) : queued.add(a);
    }
  }
  return { sent, received, queued: known ? queued : null };
}

/** The bridge's cumulative counters at `block` (0 before the bridge has code there). `queued` only when the bridge has it. */
async function countersAt(provider, bridge, block) {
  const hasQueue = typeof bridge.queued === "function";
  if (block < 0 || (provider.getCode && (await provider.getCode(bridge.address, block)) === "0x")) return { sent: "0", received: "0", ...(hasQueue ? { queued: "0" } : {}) };
  const [sent, received, queued] = await Promise.all([bridge.sent({ blockTag: block }), bridge.received({ blockTag: block }), hasQueue ? bridge.queued({ blockTag: block }) : null]);
  return { sent: sent.toString(), received: received.toString(), ...(queued !== null ? { queued: queued.toString() } : {}) };
}

/** The path's delay settings at `block` ({ delay, cancelFrom }), or null when the bridge has no breakers view (a test fake). */
async function settingsAt(provider, bridge, eid, block) {
  if (typeof bridge.breakers !== "function") return null;
  if (block < 0 || (provider.getCode && (await provider.getCode(bridge.address, block)) === "0x")) return { delay: 0, cancelFrom: 0 };
  const b = await bridge.breakers(eid, { blockTag: block });
  return { delay: Number(b.delay ?? b[4]), cancelFrom: Number(b.cancelledFrom ?? b[5]) };
}

/** An event's arguments as plain JSON (numbers as decimal strings, structs as objects): what the index and its event log store. */
function plainArgs(p) {
  const plain = (v, param) => {
    if (param.baseType === "tuple") return Object.fromEntries(param.components.map((c, i) => [c.name, plain(v[i], c)]));
    if (BigNumber.isBigNumber(v)) return v.toString();
    return v;
  };
  return Object.fromEntries(p.eventFragment.inputs.map((inp, i) => [inp.name, plain(p.args[i], inp)]));
}

/** The folded maps of a side: what a reorg rewinds (wave-5 audit #10). */
const FOLDED = ["sent", "received", "holds", "voids", "verified", "queue", "claimKey", "other", "delays"];
const clone = (x) => JSON.parse(JSON.stringify(x ?? null));
/** Stamps the watcher adds to indexed entries (bounds, first-seen times): kept across a rewind for an entry that is still there. */
function keepStamps(fresh, old) {
  for (const m of ["received", "queue"]) for (const [k, e] of Object.entries(fresh[m] ?? {})) {
    const o = old[m]?.[k];
    if (o && o.tx === e.tx) for (const f of ["srcBound", "seenAt"]) if (o[f] !== undefined) e[f] = o[f];
  }
  for (const [k, byHash] of Object.entries(fresh.verified ?? {})) for (const [h, v] of Object.entries(byHash)) {
    const o = old.verified?.[k]?.[h];
    if (o && o.tx === v.tx) for (const f of ["srcBound", "seenAt"]) if (o[f] !== undefined) v[f] = o[f];
  }
}

/**
 * Rewind `side` to checkpoint `cp` (a reorg replaced blocks above it): the folded maps are rebuilt from the base snapshot plus the kept
 * events at or below cp.block, the cursor and the proven counters go back to cp. Returns the side.
 */
function rewind(side, cp) {
  const fresh = { ...emptySide(cp.block + 1), ...clone(side.base ?? {}) };
  addEvents(fresh, (side.log ?? []).filter((e) => e.blockNumber <= cp.block));
  keepStamps(fresh, side);
  for (const m of FOLDED) side[m] = fresh[m] ?? (m === "other" ? [] : {});
  side.log = (side.log ?? []).filter((e) => e.blockNumber <= cp.block);
  side.cp = (side.cp ?? []).filter((c) => c.block <= cp.block);
  if (!side.cp.length) side.cp = [clone(cp)];
  side.next = cp.block + 1;
  side.throughBlock = cp.block;
  side.throughTime = cp.time;
  side.counted = clone(cp.counted);
  if (cp.vproven !== undefined) side.vproven = cp.vproven;
  return side;
}

/**
 * Index one side's bridge logs from its cursor towards head - lag.
 *   PROVEN PER CHUNK (fixed before audit wave 5; wave-5 audit #5). Each range is read until two reads agree (readAgreed); its events are folded and
 *     the cursor moves past it only once the bridge's own counters at the range's last block equal the last proven counters plus the
 *     range's Sent/Received/Queued amounts, the path's delay settings there equal what its DelaySets leave, and (wave-5 audit #11) every
 *     nonce the endpoint says is verified from our peer either ran (Received/Queued) or has its PacketVerified in the index, or holds
 *     nothing at the endpoint. A range that fails is read once more; still failing, the cursor stays before it and the result says
 *     `gap`. Every proven range is kept: a later failure never throws earlier ones away.
 *   BOUNDED (wave-5 audit #3/#5). At most `maxChunks` ranges and `budgetMs` of wall time per call: the result says `partial` and the next
 *     pass continues from the saved cursor.
 *   REORGS (wave-5 audit #10). The block hash of every proven range's last block is kept (the last `checkpoints`); each call re-reads the
 *     newest one first. A different hash means the chain replaced blocks the index holds: the side rewinds to the newest checkpoint
 *     whose hash still matches and reads again (`reorg`). None matching: the side is read again from its first block (`reorg.deep`).
 *     A node that cannot serve the checkpoint's block (behind it) is not a reorg: nothing is read this call (`idle`).
 *   IDLE (wave-5 audit #8). A head at or below the cursor reads nothing: `idle`, never "no gap".
 * Returns { gap?, unchecked?, partial?, idle?, reorg? }.
 */
export async function indexSide(provider, bridge, side, opts = {}, endpoint = null, settingsEid = null, verify = null) {
  const { lag = 3, chunk = 9_000, minChunk = 500, maxReads = 4, walks = 2, maxChunks = 40, budgetMs = 60_000, checkpoints = 64, clock = () => Date.now() } = opts ?? {};
  const t0 = clock();
  const out = {};
  // Reorg check: the newest checkpoint's block must still be the one proven.
  const blockAt = async (n) => {
    try {
      return await provider.getBlock(n);
    } catch {
      return null;
    }
  };
  const head = await provider.getBlockNumber();
  out.head = head;
  if (side.cp?.length) {
    const last = side.cp.at(-1);
    const b = await blockAt(last.block);
    if (!b) return { ...out, idle: true };
    if (b.hash && last.hash && lc(b.hash) !== lc(last.hash)) {
      // The newest matching checkpoint, else the base snapshot's own block (internal review after wave 5: a migrated side's history lives in the
      // base): rewind there. Matching none, the index is KEPT (never wiped: wiping it would call every past transfer forged) and the
      // side says `reindex`: a human re-reads it (move bridge-watch.json aside). The checkpoints restart at the current block.
      let match = null;
      const cands = [...side.cp.slice(0, -1)].reverse();
      if (side.baseCp) cands.push(side.baseCp);
      for (const c of cands) {
        const bb = await blockAt(c.block);
        if (!bb) return { ...out, idle: true };
        if (!bb.hash || !c.hash || lc(bb.hash) === lc(c.hash)) { match = c; break; }
      }
      out.reorg = { at: last.block, to: match ? match.block : null, deep: !match };
      if (match) rewind(side, match);
      else {
        side.reindex = { at: last.block, since: Math.floor(clock() / 1000) };
        const cur = await blockAt(side.throughBlock);
        side.cp = cur ? [{ block: side.throughBlock, hash: cur.hash ?? null, time: cur.timestamp, counted: clone(side.counted), vproven: side.vproven }] : [];
      }
    }
  }
  const top = head - lag;
  if (side.next > top) return { ...out, idle: true };
  const iface = new utils.Interface(BRIDGE_ABI);
  const epIface = new utils.Interface(ENDPOINT_ABI);
  const verifiedTopic = epIface.getEventTopic("PacketVerified");
  let unchecked = null;
  if (!side.counted) {
    try {
      side.counted = await countersAt(provider, bridge, side.next - 1);
    } catch (e) {
      unchecked = `the bridge counters at block ${side.next - 1} cannot be read (${String(e.message).slice(0, 80)}): this first range is taken as read without the counter proof`;
    }
  }
  // The path's settings at the first block, so every later DelaySet is proven against the chain (as the counters are).
  if (settingsEid !== null && !side.delays?.[String(settingsEid)]) {
    try {
      const st = await settingsAt(provider, bridge, settingsEid, side.next - 1);
      if (st) (side.delays ??= {})[String(settingsEid)] = { ...st, seeded: side.next - 1 };
    } catch (e) {
      unchecked ??= `the path's delay settings at block ${side.next - 1} cannot be read (${String(e.message).slice(0, 80)}): DelaySet is taken without the proof until they can`;
    }
  }
  // The endpoint's verified nonces from our peer at the first block: nonces at or below it are not this watcher's to prove.
  if (verify && side.vproven === undefined) {
    try {
      side.vproven = side.next - 1 < 0 ? 0 : Number(await verify.inboundNonce(side.next - 1));
    } catch (e) {
      unchecked ??= `the endpoint's verified nonce at block ${side.next - 1} cannot be read (${String(e.message).slice(0, 80)}): verified packets are proven by their logs only until it can`;
    }
  }
  if (!side.base) {
    side.base = Object.fromEntries(FOLDED.map((m) => [m, clone(side[m])]));
    // The base's own checkpoint (internal review after wave 5): a rewind past every kept checkpoint lands here, history intact.
    if (side.throughBlock >= 0 && side.counted) {
      const b = await blockAt(side.throughBlock);
      if (b) side.baseCp = { block: side.throughBlock, hash: b.hash ?? null, time: b.timestamp, counted: clone(side.counted), vproven: side.vproven };
    }
  }
  let size = chunk, done = 0;
  while (side.next <= top) {
    if (done >= maxChunks || clock() - t0 >= budgetMs) return { ...out, unchecked, partial: true };
    const from = side.next, to = Math.min(top, from + size - 1);
    let why = null, folded = false, refused = false;
    for (let walk = 0; walk < walks && !folded; walk++) {
      let logs, epLogs = [];
      try {
        logs = await readAgreed(provider, { address: bridge.address, fromBlock: from, toBlock: to }, maxReads);
        // Pre-fix 3: the endpoint's PacketVerified for OUR bridge, same range, same agreeing reads (receiver is not indexed: filtered here).
        if (logs !== null && endpoint) epLogs = await readAgreed(provider, { address: endpoint, topics: [verifiedTopic], fromBlock: from, toBlock: to }, maxReads);
      } catch (e) {
        if (!e.refused || size <= minChunk) throw e;
        refused = true;
        break;
      }
      if (logs === null || epLogs === null) {
        why = `${maxReads} reads of blocks ${from}-${to} never agreed`;
        continue;
      }
      const times = new Map();
      const at = async (n) => {
        if (!times.has(n)) times.set(n, (await provider.getBlock(n)).timestamp);
        return times.get(n);
      };
      const events = [];
      for (const l of logs) {
        let p;
        try { p = iface.parseLog(l); } catch { continue; }
        events.push({ name: p.name, args: plainArgs(p), blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash, time: await at(Number(l.blockNumber)) });
      }
      for (const l of epLogs) {
        let p;
        try { p = epIface.parseLog(l); } catch { continue; }
        if (lc(p.args.receiver) !== lc(bridge.address)) continue;
        events.push({ name: p.name, args: plainArgs(p), blockNumber: Number(l.blockNumber), transactionHash: l.transactionHash, time: await at(Number(l.blockNumber)) });
      }
      const t = totalsOf(events, side);
      // DelaySet moves no counter: the settings the index would hold after these events must be the chain's at `to`.
      const known = settingsEid !== null ? side.delays?.[String(settingsEid)] : undefined;
      if (known) {
        const last = events.filter((e) => e.name === "DelaySet" && Number(e.args.srcEid) === Number(settingsEid)).at(-1);
        const want = last ? { delay: Number(last.args.delay), cancelFrom: Number(last.args.cancelFrom) } : known;
        const st = await settingsAt(provider, bridge, settingsEid, to);
        if (st && (st.delay !== want.delay || st.cancelFrom !== want.cancelFrom)) {
          why = `blocks ${from}-${to}: the logs read leave the path's delay ${want.delay} s / cutoff ${want.cancelFrom}, the bridge says ${st.delay} s / ${st.cancelFrom}: a DelaySet is missing`;
          continue;
        }
      }
      let counted = null;
      if (side.counted) {
        const now = await countersAt(provider, bridge, to);
        const wantSent = BigNumber.from(side.counted.sent).add(t.sent), wantReceived = BigNumber.from(side.counted.received).add(t.received);
        if (!wantSent.eq(now.sent) || !wantReceived.eq(now.received)) {
          why = `blocks ${from}-${to}: the logs read hold sent ${utils.formatEther(wantSent)} / received ${utils.formatEther(wantReceived)}, the bridge counters say ${utils.formatEther(now.sent)} / ${utils.formatEther(now.received)}`;
          continue;
        }
        // The queue: a Queued, Claimed, cancel or restore hidden by an empty log answer breaks this equation as a Sent or Received does.
        if (side.counted.queued !== undefined && now.queued !== undefined) {
          if (t.queued === null) unchecked = `blocks ${from}-${to}: a claim was cancelled or restored whose Queued is before the watcher's first block, so the queued counter is taken without the proof`;
          else if (!BigNumber.from(side.counted.queued).add(t.queued).eq(now.queued)) {
            why = `blocks ${from}-${to}: the logs read hold queued ${utils.formatEther(BigNumber.from(side.counted.queued).add(t.queued))}, the bridge counter says ${utils.formatEther(now.queued)}`;
            continue;
          }
        }
        counted = now;
      } else {
        // No proven start (unchecked): fold, and prove every later range from the counters read here.
        try { counted = await countersAt(provider, bridge, to); } catch { /* still unchecked next pass */ }
      }
      // Verified packets (wave-5 audit #11): no counter moves with a PacketVerified, so two reads of one node "agreeing" prove nothing. The
      // endpoint's own state does: every nonce from our peer it counts as verified at `to` either ran here (its Received/Queued is
      // counter-proven), or its PacketVerified is in these logs or the index, or the endpoint stores nothing for it (executed,
      // burned, skipped). A stored payload with no log is a gap: a forged packet may be waiting behind an empty answer.
      let vnow = side.vproven;
      if (verify && side.vproven !== undefined) {
        try {
          vnow = Number(await verify.inboundNonce(to));
          const key = (n) => `${verify.srcEid}:${n}`;
          const ours = lc(verify.sender);
          const seen = new Set(events.flatMap((e) => (e.name === "Received" || e.name === "Queued" ? [key(e.args.nonce)] : e.name === "PacketVerified" && lc(e.args.origin.sender) === ours ? [key(e.args.origin.nonce)] : [])));
          const indexed = (k) => side.received[k] || side.queue?.[k] || Object.values(side.verified?.[k] ?? {}).some((v) => v.sender === ours);
          for (let n = side.vproven + 1; n <= vnow && !why; n++) {
            if (seen.has(key(n)) || indexed(key(n))) continue;
            const stored = lc(await verify.stored(n, to));
            if (!/^0x0{64}$/.test(stored) && !/^0xf{64}$/.test(stored)) why = `blocks ${from}-${to}: the endpoint holds a verified payload at nonce ${n} from the peer and the logs read hold no PacketVerified for it`;
          }
          if (why) continue;
        } catch (e) {
          vnow = side.vproven;
          unchecked ??= `blocks ${from}-${to}: the endpoint's verified nonces could not be read (${String(e.message).slice(0, 80)}): verified packets here are proven by their logs only`;
        }
      }
      // Proven: fold, keep the events for a rewind, checkpoint the range's last block.
      const b = await provider.getBlock(to);
      addEvents(side, events);
      (side.log ??= []).push(...events);
      side.counted = counted ?? side.counted;
      if (vnow !== undefined) side.vproven = vnow;
      side.next = to + 1;
      side.throughBlock = to;
      side.throughTime = b.timestamp;
      (side.cp ??= []).push({ block: to, hash: b.hash ?? null, time: b.timestamp, counted: clone(side.counted), vproven: side.vproven });
      if (side.cp.length > checkpoints) {
        const drop = side.cp.splice(0, side.cp.length - checkpoints);
        const upTo = drop.at(-1).block;
        const fold = side.log.filter((e) => e.blockNumber <= upTo);
        const base = { ...emptySide(0), ...clone(side.base) };
        addEvents(base, fold);
        side.base = Object.fromEntries(FOLDED.map((m) => [m, clone(base[m])]));
        side.baseCp = clone(drop.at(-1));
        side.log = side.log.filter((e) => e.blockNumber > upTo);
      }
      folded = true;
      done += 1;
    }
    if (refused) {
      size = Math.floor(size / 2);
      continue;
    }
    if (!folded) return { ...out, gap: why, unchecked };
  }
  return { ...out, unchecked };
}

/** Every term of the supply equation at ONE block (wave-5 audit #14): the head is read once and every call carries it as its blockTag. */
export async function readSupply(provider, a, bridge) {
  const c = (x, abi) => new Contract(x, abi, provider);
  const ledger = c(a.ledger, LEDGER_4663_ABI), params = c(a.params, PARAMS_ABI);
  const blockTag = await provider.getBlockNumber();
  const at = { blockTag };
  const n = (await params.ilkCount(at)).toNumber();
  const states = await Promise.all([...Array(n).keys()].map(async (i) => ledger.ilkState(await params.ilks(i, at), at)));
  const zero = BigNumber.from(0);
  const [totalSupply, reserveBacked, migrator, pegKeeper, received, sent] = await Promise.all([
    c(a.usd, SUPPLY_ABI).totalSupply(at), ledger.reserveBacked(at),
    a.migrator ? c(a.migrator, SUPPLY_ABI).outstanding(at) : zero, a.pegHook ? c(a.pegHook, PEG_HOOK_ABI).outstanding(at) : zero,
    bridge.received(at), bridge.sent(at),
  ]);
  return { totalSupply, debts: states.map((s) => s.debt), badDebts: states.map((s) => s.badDebt), reserveBacked, migrator, pegKeeper, received, sent };
}

/** The send label of a claim: the journal finds a claim's sends by it, across restarts. */
export const claimLabel = (srcEid, guid) => `bridge claim ${Number(srcEid)}:${lc(guid)}`;

/** From the send journal: the claim labels with a send still open (its own intent, or a cancel/replacement of it), every hash ever
 *  signed per claim label, and every hash the journal records as MINED (wave-5 audit #22: a mined claim is done whatever a lagging node says). */
function claimJournal(scope) {
  const open = new Set();
  for (const it of pendingIntents(scope)) for (const l of [it.label, it.cancelOf]) if (typeof l === "string" && l.startsWith("bridge claim ")) open.add(l);
  const signed = new Map();
  const mined = new Map(); // hash -> when the journal recorded it mined (ms)
  const p = statePath("journal.jsonl");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"bridge claim ') && !line.includes('"mined"')) continue;
      try {
        const j = JSON.parse(line);
        if ((j.scope ?? "tx") !== scope) continue;
        if (j.step === "signed" && String(j.label).startsWith("bridge claim ")) {
          if (!signed.has(j.label)) signed.set(j.label, []);
          signed.get(j.label).push(j.hash);
        } else if (j.step === "mined" && j.hash) mined.set(String(j.hash).toLowerCase(), Date.parse(j.at ?? 0) || 0);
      } catch { /* a torn last line */ }
    }
  }
  return { open, signed, mined };
}

/** Is the path's queue breaker tripped (ImdBridge `breakers(srcEid).tripped`)? Null when the bridge has no breaker view (a fake);
 *  throws when it cannot be read (the caller then claims nothing: could-not-tell is not open). */
async function breakerTripped(bridge, eid) {
  if (typeof bridge.breakers !== "function") return null;
  const b = await bridge.breakers(eid);
  return Boolean(b.tripped ?? b[2]);
}

const CLOSED = /paused|tripped/i;
const CUT = /CancelledSince/;

/**
 * AUTO-CLAIM: claim every HONEST queued transfer on this keeper's own chain (`side` = this chain, `src` = the peer) whose
 * claimableAt this chain's clock has passed, while the path is open. Returns the alerts. Never claims an unmatched or unjudged one.
 */
export async function autoClaim(ctx, { side, src, srcEid, dstEid, name, W = {}, held = new Set() }) {
  const out = [];
  const bridge = ctx.book.bridge;
  if (W.autoClaim === false || typeof bridge?.claims !== "function") return out;
  // The path's settings, read THIS pass: the delay in force (it may have changed since a claim queued) and the bulk cutoff. A
  // bridge with no breakers view is a test fake only: Queued's claimableAt then stands, and the simulation refuses an early one.
  let settings = null, closed = null;
  if (typeof bridge.breakers === "function") {
    try {
      const b = await bridge.breakers(srcEid);
      settings = { delay: Number(b.delay ?? b[4]), cutoff: Number(b.cancelledFrom ?? b[5]), tripped: Boolean(b.tripped ?? b[2]) };
    } catch (e) {
      closed = `of unknown delay and breaker state (breakers() unreadable: ${String(e.message).slice(0, 80)})`;
    }
  }
  const pending = Object.entries(side.queue ?? {}).filter(([k, q]) => q.state === "pending" && Number(k.split(":")[0]) === Number(srcEid));
  const queuedAtOf = (q) => q.queuedAt ?? q.time;
  const isCut = (queuedAt) => settings !== null && settings.cutoff !== 0 && queuedAt >= settings.cutoff;
  const sum = (xs) => utils.formatEther(xs.reduce((a, [, q]) => a.add(q.amount), BigNumber.from(0)));
  // Before SET_BRIDGE (launch: the path is paused until usd.bridge() names this bridge, then swept and unpaused) every inbound message
  // QUEUES and a claim reverts in mint: the claims wait, said once as info; nothing is sent (the wave-5b contracts snapshot).
  const usd = ctx.book.usd;
  if (pending.length && typeof usd?.bridge === "function") {
    let wired = null;
    try {
      wired = lc(await usd.bridge()) === lc(bridge.address);
    } catch (e) {
      out.push({ level: "warn", key: `bridge-claim-unread-${name}-wiring`, msg: `${name}: imdUSD.bridge() could not be read (${String(e.message).slice(0, 80)}); no claim sent this pass` });
      return out;
    }
    if (!wired) {
      out.push({ level: "info", key: `bridge-not-wired-${name}`, msg: `${name}: imdUSD.bridge() does not name this bridge yet (SET_BRIDGE pending): ${pending.length} queued claim(s) (${sum(pending)} imdUSD) wait; a claim would revert in mint. After SET_BRIDGE: the void sweep, then UNPAUSE` });
      return out;
    }
  }
  if (settings?.cutoff) {
    const held = pending.filter(([, q]) => isCut(queuedAtOf(q)));
    out.push({ level: "info", key: `bridge-bulk-cancel-${name}`, msg: `${name}: the Safe's bulk-cancel cutoff on the path from endpoint ${srcEid} is set at ${new Date(settings.cutoff * 1000).toISOString()} (${name} clock): ${held.length} pending claim(s) (${sum(held)} imdUSD) queued since are held, not lost, until a SET_DELAY lifts or moves it. The keeper claims none of them meanwhile` });
  }
  if (!pending.length) return out;
  const now = (await ctx.provider.getBlock("latest")).timestamp; // this chain's clock: queuedAt and the cutoff are in it
  const claimableAt = (q) => (settings ? queuedAtOf(q) + settings.delay : q.claimableAt);
  const due = [];
  for (const [key, q] of pending) {
    const nonce = key.split(":")[1];
    if (judgeQueued(q, nonce, src, dstEid).verdict !== "honest") continue; // P2: an unmatched claim is never sent (the forged alert speaks)
    if (isCut(queuedAtOf(q))) continue; // held by the bulk cutoff: no send, no warning (the info alert above speaks)
    if (claimableAt(q) <= now) due.push([nonce, q]);
  }
  if (!due.length) return out;
  // The path: paused, or its claim breaker tripped: claim nothing, say what waits. Unreadable = closed.
  if (!closed && settings?.tripped) closed = "TRIPPED by the queue breaker (claims stop until the timelocked release)";
  if (!closed) {
    try {
      if (await bridge.paused(srcEid)) closed = "PAUSED (only UNPAUSE, 48 h, reopens it)";
    } catch (e) {
      closed = `of unknown state (paused() unreadable: ${String(e.message).slice(0, 80)})`;
    }
  }
  if (!closed && settings === null) {
    try {
      if (await breakerTripped(bridge, srcEid)) closed = "TRIPPED by the queue breaker (claims stop until the timelocked release)";
    } catch (e) {
      closed = `of unknown breaker state (${String(e.message).slice(0, 80)})`;
    }
  }
  if (closed) {
    out.push({ level: closed.startsWith("PAUSED") ? "warn" : "critical", key: `bridge-claims-closed-${name}`, msg: `${due.length} matured honest claim(s) on ${name} (${sum(due)} imdUSD) wait: the path from endpoint ${srcEid} is ${closed}. They are claimed once it is open` });
    return out;
  }
  const scope = ctx.signer?.journalScope ?? "tx";
  // Settle the send journal first, as every send does (lib/tx.mjs): a claim send that mined, or whose nonce something else used, is
  // no longer open. Without this a dropped claim send would hold its claim until some other loop happened to send. ctx.settleSends:
  // tests only.
  if (ctx.execute) {
    const settle = ctx.settleSends ?? (ctx.signer?.rebroadcast ? () => settleIntents(ctx.provider, ctx.signer.address, ctx.signer.rebroadcast, scope) : null);
    if (settle) await withSendLock(ctx, settle); // never beside another lane's send (internal review after wave 5)
  }
  const journal = ctx.execute ? claimJournal(scope) : { open: new Set(), signed: new Map(), mined: new Map() };
  // Urgent from maturity (wave-5 audit #17): one transaction, the user has already waited the delay. claimUrgentSeconds > 0 restores a
  // routine first period; a routine skip then still says why.
  const urgentAfter = W.claimUrgentSeconds ?? 0;
  for (const [nonce, q] of due) {
    const label = claimLabel(srcEid, q.guid);
    // P3: a send of this claim still open (or its replacement or cancel): wait for it. One the journal shows mined: done.
    if (journal.open.has(label)) continue;
    // The journal's "mined" is trusted for minedTrustSeconds (30 min) only (internal review after wave 5): long enough for a lagging node to catch up,
    // not for ever (a reorg can drop a mined claim; the chain's claims() then says pending again and the claim goes again).
    const trust = (W.minedTrustSeconds ?? 1800) * 1000;
    let mined = (journal.signed.get(label) ?? []).find((h) => { const at = journal.mined.get(String(h).toLowerCase()); return at !== undefined && Date.now() - at < trust; }) ?? null;
    for (const h of mined ? [] : journal.signed.get(label) ?? []) {
      const rc = await ctx.provider.getTransactionReceipt(h).catch(() => null);
      if (rc && rc.status === 1) mined = h;
    }
    if (mined) continue; // its Claimed arrives with the logs
    // The chain's own record, read now: someone else may have claimed it, the Safe may have cancelled it. It only ever STOPS a send:
    // the index's state moves by the proven logs alone (a lagging node's "cancelled" must not shadow a later ClaimRestored).
    let c;
    try {
      c = await bridge.claims(srcEid, q.guid);
    } catch (e) {
      out.push({ level: "warn", key: `bridge-claim-unread-${name}-${nonce}`, msg: `${name}: claims(${srcEid}, ${q.guid}) could not be read (${String(e.message).slice(0, 80)}); not claimed this pass` });
      for (const k of ["mismatch", "late", "refused"]) held.add(`bridge-claim-${k}-${name}-${nonce}`); // unread: they stand (#15)
      continue;
    }
    const state = Number(c.state ?? c[3]);
    if (CLAIM_STATE[state]) continue;
    const chainAmount = BigNumber.from(c.amountSD ?? c[1]).mul(CONVERSION).toString();
    if (state !== 1 || lc(c.to ?? c[0]) !== q.to || chainAmount !== q.amount) {
      out.push({ level: "critical", key: `bridge-claim-mismatch-${name}-${nonce}`, msg: `${name}: the bridge's claims(${srcEid}, ${q.guid}) = state ${state}, ${utils.formatEther(chainAmount)} to ${lc(c.to ?? c[0])}, is not the indexed Queued (${utils.formatEther(q.amount)} to ${q.to}): not claimed` });
      continue;
    }
    // The chain's own queuedAt, against the delay read this pass: never Queued's claimableAt.
    const chainQueuedAt = Number(c.queuedAt ?? c[2]);
    if (isCut(chainQueuedAt) || (settings && chainQueuedAt + settings.delay > now)) continue;
    const late = now - claimableAt(q);
    const r = await act(ctx, label, bridge, "claim", [srcEid, q.guid], { tier: late >= urgentAfter ? "urgent" : "routine" });
    if (r?.hash) continue; // mined: its Claimed arrives with the logs
    const why = r?.refused ?? r?.skipped ?? (r?.pending ? `sent ${r.pending}, not mined yet` : null);
    if (r?.refused && CUT.test(r.refused)) continue; // a cutoff set between the read and the simulation: held, the info alert speaks next pass
    if (r?.refused && CLOSED.test(r.refused)) out.push({ level: "critical", key: `bridge-claims-closed-${name}`, msg: `${name}: claim ${q.guid} (nonce ${nonce}) refused: ${r.refused}. The path from endpoint ${srcEid} is closed to claims` });
    else if (r?.refused && !r.watch) out.push({ level: "warn", key: `bridge-claim-refused-${name}-${nonce}`, msg: `${name}: claim of nonce ${nonce} (${utils.formatEther(q.amount)} imdUSD to ${q.to}) refused in simulation: ${r.refused}` });
    if (r?.skipped && !r.pending && ctx.execute) out.push({ level: "warn", key: `bridge-claim-late-${name}-${nonce}`, msg: `${name}: ${utils.formatEther(q.amount)} imdUSD to ${q.to} (nonce ${nonce}) matured ${Math.round(late / 60)} min ago and its claim was not sent: ${r.skipped}` });
    else if (late > (W.claimLateSeconds ?? 3600) && ctx.execute && !r?.pending) out.push({ level: "warn", key: `bridge-claim-late-${name}-${nonce}`, msg: `${name}: ${utils.formatEther(q.amount)} imdUSD to ${q.to} (nonce ${nonce}) matured ${Math.round(late / 60)} min ago and is not claimed${why ? `: ${why}` : ""}` });
  }
  return out;
}

/**
 * Startup check (auto-claim; wave-5 audit #20): a record that names a bridge needs the watcher AND auto-claim to actually run on this
 * chain: decided from what will run (the loops after <NAME>_ENABLED and --only, BRIDGE_WATCH.autoClaim), on both chains. Returns the
 * message, or null. `loops`/`only` default to what keeper.mjs would run.
 */
export function bridgeWatchOff(cfg, record, { loops = null, only = null } = {}) {
  const b = record?.bridge;
  if (!b || /^0x0{40}$/i.test(b)) return null;
  const main = Number(cfg.CHAIN_ID ?? 1) === 1;
  const names = (loops ?? (main ? (cfg.BRIDGE_WATCH?.enabled ? ["bridge"] : []) : ["bridge"])).map((l) => (typeof l === "string" ? l : l.name));
  const runs = names.includes("bridge") && cfg.BRIDGE_ENABLED !== false && (!only || only.includes("bridge"));
  const chain = main ? "mainnet" : String(cfg.CHAIN_ID);
  if (!runs) {
    const why = main && !cfg.BRIDGE_WATCH?.enabled ? "BRIDGE_WATCH.enabled is off on mainnet" : cfg.BRIDGE_ENABLED === false ? "BRIDGE_ENABLED is false" : only && !only.includes("bridge") ? `--only ${only.join(",")} leaves the bridge loop out` : "the bridge loop is not among the loops";
    return `the deployment names a bridge (${b}) but ${why}: transfers queued on ${chain} are NOT auto-claimed and no forged Received/Queued on ${chain} is watched by this process${main ? ". Set BRIDGE_WATCH.enabled with PEERS[4663] and BRIDGE_WATCH.peer.bridge" : ""}`;
  }
  if (cfg.BRIDGE_WATCH?.autoClaim === false) return `the deployment names a bridge (${b}) and BRIDGE_WATCH.autoClaim is false: honest transfers queued on ${chain} are watched but NOT claimed by this keeper`;
  return null;
}

/** Where a page to the Safe signers would go. PLACEHOLDER: no paging code; alerts.mjs already sends Telegram. */
function page(/* alert */) {
  // Not built: page the Safe signers for every critical bridge alert.
}

/** The first block at which `address` has code (binary search on getCode; needs an archive node). Null when it cannot be read. */
export async function findDeployBlock(provider, address, head) {
  if (typeof provider.getCode !== "function") return null;
  try {
    if ((await provider.getCode(address, head)) === "0x") return null;
    let lo = 0, hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await provider.getCode(address, mid)) === "0x") lo = mid + 1;
      else hi = mid;
    }
    return lo;
  } catch {
    return null;
  }
}

/**
 * Stamp the source bound of every entry on `side` (wave-5 audit #1): `bound` = the OTHER chain's highest head, read now. An entry is
 * stamped only once `lagSeconds` of the keeper's own wall clock have passed since it was first indexed (`seenAt`): an honest Sent was
 * on its chain before its Received was indexed, so a source node that lags the chain by up to lagSeconds + the delivery time still
 * serves a head at or past it. Local time is compared only with local time; chain clocks never with each other or with local time.
 * A source lagging further is not covered (README "Not proven"). `bound` null (unreadable): nothing is stamped.
 */
export function stampBounds(side, bound, { now = null, lagSeconds = 0 } = {}) {
  const each = (e) => {
    // A bound past the source's highest head now was stamped from a wrong head (internal review after wave 5): it could never be reached, and the
    // entry would stay unverified for good. Stamp it again with the head read now (the lag rule already holds for it).
    if (e.srcBound !== undefined && bound !== null && bound !== undefined && e.srcBound > bound) e.srcBound = bound;
    if (e.srcBound !== undefined) return;
    if (now !== null) e.seenAt ??= now;
    if (bound === null || bound === undefined) return;
    if (now !== null && now - e.seenAt < lagSeconds) return;
    e.srcBound = bound;
  };
  for (const r of Object.values(side.received)) each(r);
  for (const q of Object.values(side.queue ?? {})) each(q);
  for (const byHash of Object.values(side.verified ?? {})) for (const v of Object.values(byHash)) each(v);
  return side;
}

/**
 * The counter check without a stale-source false alarm (#1): `dstNow` (received + queued on the destination) is recorded with the
 * keeper's wall time; the source's sent() read NOW is compared with the newest destination reading at least `lagSeconds` old. A
 * honest source node lagging up to lagSeconds still reflects every burn behind that older reading. Returns { alerts, hist }.
 */
export function laggedCounters(hist = [], { dstNow, srcSent, now, lagSeconds, srcName, dstName }) {
  const h = [...hist, { at: now, v: BigNumber.from(dstNow).toString() }];
  const old = h.filter((x) => now - x.at >= lagSeconds);
  const ref = old.at(-1);
  const keep = [...(ref ? [ref] : []), ...h.filter((x) => now - x.at < lagSeconds)];
  if (!ref || srcSent === null || srcSent === undefined) return { alerts: [], hist: keep };
  return { alerts: counterAlerts({ dstReceived: ref.v, dstQueued: 0, srcSent, srcName, dstName }), hist: keep };
}

/**
 * One watcher pass (wave-5 audit #1/#2/#4/#5/#8/#10/#11/#14/#15):
 *   - every alert is RAISED THE MOMENT IT IS JUDGED: a read that throws later in the pass never drops it (#2);
 *   - the PEER chain's reads are isolated: while its RPC does not answer, the home side is still indexed and judged on the saved peer
 *     index (a new Received/Queued at home goes unverified at 30 min), honest matured claims are still sent, the home checks still
 *     run, and critical `bridge-peer-unread-*` names the outage (#4);
 *   - every standing alert stays until a pass that read its condition: a pass that could not read something settles nothing it
 *     could not re-judge (#15, #8).
 */
export async function runBridge(ctx) {
  const { book, cfg, log, provider } = ctx;
  const W = cfg.BRIDGE_WATCH ?? {};
  // Mainnet's book has no bridge contract: read it from the record when the record names one (BRIDGE_WATCH.enabled on mainnet).
  if (!book.bridge && book.record?.bridge) book.bridge = new Contract(book.record.bridge, BRIDGE_ABI, provider);
  if (!book.bridge) return log("bridge  no bridge in this deployment");
  const home = Number(cfg.CHAIN_ID ?? 1);
  const peerId = Number(W.peerChainId ?? (home === 1 ? 4663 : 1));
  const peerProvider = ctx.peers?.[peerId];
  if (!peerProvider || !W.peer?.bridge) throw new Error(`the bridge watcher needs PEERS[${peerId}] and BRIDGE_WATCH.peer.bridge`);
  const peerBridge = ctx.peerBridge ?? new Contract(W.peer.bridge, BRIDGE_ABI, peerProvider); // ctx.peerBridge: tests only
  const names = { [home]: home === 1 ? "mainnet" : String(home), [peerId]: peerId === 1 ? "mainnet" : String(peerId) };
  const HOME = names[home], PEER = names[peerId];
  const wall = ctx.clock ?? (() => Date.now() / 1000); // the keeper's own clock (ctx.clock: tests)
  const lagSeconds = W.peerLagSeconds ?? 600;
  const unverifiedSeconds = W.unverifiedSeconds ?? 1800;
  const file = "bridge-watch.json";
  const s = readStateOr(file, {});
  const raisedKeys = new Set();
  const heldPrefixes = []; // standing keys whose condition this pass could not read
  const heldKeys = new Set(["bridge-watch-off"]);
  let complete = true;
  const raise = async (alerts) => {
    for (const a of alerts) {
      raisedKeys.add(a.key);
      if (a.level === "critical") page(a);
      await ctx.alerts.raise(a.level, a.key, a.msg);
    }
  };
  const homeStart = Number(W.fromBlock ?? book.record.deployBlock ?? 0);
  const homeSide = s.home && s.home.bridge === lc(book.bridge.address) ? s.home : { ...emptySide(homeStart), bridge: lc(book.bridge.address) };
  let peerSide = s.peer && s.peer.bridge === lc(peerBridge.address) ? s.peer : null;
  // A state file written before the wave-5 fixes (internal review after wave 5): no start, no checkpoints, bounds stamped with no lag rule.
  // Its start is the configured one (never the cursor), and every bound stamped without a first-seen time is dropped, to be
  // stamped again under the lag rule; the base snapshot and its checkpoint are taken by the first indexSide call.
  const migrate = (side, start) => {
    if (!side || side.start !== undefined) return;
    side.start = start ?? null;
    for (const r of [...Object.values(side.received ?? {}), ...Object.values(side.queue ?? {})]) if (r.srcBound !== undefined && r.seenAt === undefined) delete r.srcBound;
    for (const byHash of Object.values(side.verified ?? {})) for (const v of Object.values(byHash)) if (v.srcBound !== undefined && v.seenAt === undefined) delete v.srcBound;
  };
  migrate(homeSide, homeStart);
  migrate(peerSide, W.peer.fromBlock ? Number(W.peer.fromBlock) : null);
  const hist = s.hist ?? {};
  // A peer side made this pass from a start the watcher could not find is never saved (internal review after wave 5): next pass looks again.
  const save = () => writeState(file, { home: homeSide, peer: peerSide && !peerSide.ephemeral ? peerSide : s.peer ?? null, hist });
  // The peer's reads: the first failure marks the peer unread for the rest of the pass; nothing of the home side waits on it.
  let peerUnread = null;
  const peerRead = async (f) => {
    if (peerUnread) return null;
    try {
      return await f();
    } catch (e) {
      peerUnread = e;
      return null;
    }
  };
  try {
    if (!peerSide) {
      // A peer bridge with no start block configured (wave-5 audit #5): find its deploy block instead of walking the chain from genesis.
      let from = W.peer.fromBlock;
      if (!from) {
        const ph = await peerRead(() => peerProvider.getBlockNumber());
        const found = ph === null ? null : await findDeployBlock(peerProvider, peerBridge.address, ph);
        if (found !== null) from = found;
        else if (typeof peerProvider.getCode === "function") {
          await raise([{ level: "critical", key: `bridge-peer-fromblock-${PEER}`, msg: `BRIDGE_WATCH.peer.fromBlock is not set and the ${PEER} bridge's deploy block could not be found (${peerUnread ? String(peerUnread.message).slice(0, 80) : "no code / no archive"}): set it to the bridge's deploy block` }]);
        }
      }
      // Unknown = the peer did not answer, or it can be searched and the search failed: that side is not saved (internal review after wave 5) and the
      // peer is unread this pass. A provider with no getCode at all (a test fake) walks from the configured block as before.
      const unknown = !from && (peerUnread || typeof peerProvider.getCode === "function");
      peerSide = { ...emptySide(Number(from ?? 0)), bridge: lc(peerBridge.address), ...(unknown ? { ephemeral: true } : {}) };
      if (unknown) peerUnread ??= new Error("the peer bridge's first block is unknown (BRIDGE_WATCH.peer.fromBlock unset, search failed)");
    }
    // Counters first, each destination before its source (see counterAlerts); `received` before `queued` on each destination.
    const queuedOf = async (br) => (typeof br.queued === "function" ? br.queued() : BigNumber.from(0));
    const homeReceived = await book.bridge.received();
    const homeQueued = await queuedOf(book.bridge);
    const peerSent = await peerRead(() => peerBridge.sent());
    const peerReceived = await peerRead(() => peerBridge.received());
    const peerQueued = await peerRead(() => queuedOf(peerBridge));
    const homeSent = await book.bridge.sent();
    // One clock per comparison (see ONE CLOCK above): each chain's head time read BEFORE either side is indexed, for the stuck ages.
    const timeOfHead = async (p) => (await p.getBlock(await p.getBlockNumber())).timestamp;
    const homeBefore = await timeOfHead(provider);
    const peerBefore = await peerRead(() => timeOfHead(peerProvider));
    // Each chain's EndpointV2: from config, else the bridge's own immutable `endpoint()`, kept in the side's state.
    const endpointOf = async (side, br, configured) => {
      if (W.watchVerified === false) return null;
      if (!side.endpoint) side.endpoint = configured ? lc(configured) : typeof br.endpoint === "function" ? lc(await br.endpoint()) : null;
      return side.endpoint;
    };
    const homeEndpoint = await endpointOf(homeSide, book.bridge, W.endpoint);
    const peerEndpoint = await peerRead(() => endpointOf(peerSide, peerBridge, W.peer.endpoint));
    const epAt = (chainId, p, endpoint) => ctx.endpointAt?.(chainId) ?? new Contract(endpoint, ENDPOINT_ABI, p); // ctx.endpointAt: tests only
    // Verified nonces from the peer at the endpoint (wave-5 audit #11): proven against the endpoint's state, not two reads of one node.
    const verifyOf = (chainId, p, endpoint, receiver, srcEid, senderAddr) => {
      if (!endpoint || W.verifyNonces === false) return null;
      const ep = epAt(chainId, p, endpoint);
      if (typeof ep.inboundNonce !== "function") return null;
      const sender = lc(utils.hexZeroPad(senderAddr, 32));
      return { srcEid, sender, inboundNonce: (b) => ep.inboundNonce(receiver, srcEid, sender, { blockTag: b }), stored: (n, b) => ep.inboundPayloadHash(receiver, srcEid, sender, n, { blockTag: b }) };
    };
    const logOpts = (o) => ({ clock: () => wall() * 1000, ...(o ?? {}) });
    const indexed = {};
    try {
      indexed[HOME] = await indexSide(provider, book.bridge, homeSide, logOpts(W.homeLogs ?? cfg.LOGS), homeEndpoint, EID[peerId], verifyOf(home, provider, homeEndpoint, book.bridge.address, EID[peerId], peerBridge.address));
    } catch (e) {
      complete = false;
      indexed[HOME] = { failed: e };
    }
    if (!peerUnread) {
      try {
        indexed[PEER] = await indexSide(peerProvider, peerBridge, peerSide, logOpts(W.peerLogs), peerEndpoint, EID[home], verifyOf(peerId, peerProvider, peerEndpoint, peerBridge.address, EID[home], book.bridge.address));
      } catch (e) {
        peerUnread = e;
      }
    }
    // ...and each chain's highest head read AFTER both sides are indexed: every Sent behind a Received indexed `lagSeconds` ago is at
    // or below it (#1). An unreadable head stamps nothing.
    // The highest head of a chain's RPCs, but never more than `maxSpread` blocks past the first RPC's (internal review after wave 5): one RPC with a
    // wrong, too-high head must not push every bound past anything the source will ever be read through.
    const headOf = async (p, maxSpread) => {
      const first = await p.getBlockNumber();
      const hi = typeof p.maxHead === "function" ? await p.maxHead() : first;
      return Math.min(hi, first + maxSpread);
    };
    const now = wall();
    const spreadOf = (p, c) => p.maxSpread ?? c ?? 20;
    stampBounds(peerSide, await headOf(provider, spreadOf(provider, cfg.READ_MAX_SPREAD_BLOCKS)).catch(() => null), { now, lagSeconds });
    stampBounds(homeSide, peerUnread ? null : await peerRead(() => headOf(peerProvider, spreadOf(peerProvider, cfg.PEERS?.[peerId]?.READ_MAX_SPREAD_BLOCKS))), { now, lagSeconds });
    save();

    if (peerUnread) {
      complete = false;
      await raise([{ level: "critical", key: `bridge-peer-unread-${PEER}`, msg: `the ${PEER} RPC does not answer the bridge watcher (${String(peerUnread.message).slice(0, 120)}): transfers into ${HOME} cannot be proven honest or forged meanwhile (each goes unverified at ${Math.round(unverifiedSeconds / 60)} min); claims already matched are still sent. Fix PEERS[${peerId}]` }]);
    }
    // A home index that cannot be read (RPCs disagree, a counter read fails) is a GAP, not a passing warning (internal review after wave 5): nothing past
    // the cursor is judged, so it turns critical after unverifiedSeconds like any gap.
    if (indexed[HOME].failed) indexed[HOME] = { gap: `the logs or counters could not be read (${String(indexed[HOME].failed.message).slice(0, 120)})` };
    // A head that stops moving (a frozen lone RPC) is said (internal review after wave 5): critical `bridge-head-stalled-*` once the cursor's chain has
    // not advanced for headStallSeconds (600 s) of the keeper's own clock.
    for (const [name, side] of [[HOME, homeSide], [PEER, peerSide]]) {
      const r = indexed[name];
      const h = r?.head ?? null;
      if (h === null) continue;
      if (!side.headSeen || h > side.headSeen.head) side.headSeen = { head: h, at: now };
      const still = now - side.headSeen.at;
      if (still >= (W.headStallSeconds ?? 600)) await raise([{ level: "critical", key: `bridge-head-stalled-${name}`, msg: `${name}: the read RPC's head has stayed at block ${side.headSeen.head} for ${Math.round(still)}s: the watcher judges nothing new on ${name} (a frozen or stuck RPC). Fix the RPC` }]);
    }
    for (const [name, side] of [[HOME, homeSide], [PEER, peerSide]]) {
      if (side.reindex) await raise([{ level: "critical", key: `bridge-reindex-${name}`, msg: `${name}: a reorg replaced block ${side.reindex.at}, deeper than every checkpoint the watcher keeps: the index was KEPT and may hold transfers the chain no longer has. Re-index: stop the keeper, move state bridge-watch.json aside, start it again (it reads ${name} from its first block)` }]);
    }
    // Gaps, held across a pass that read nothing (#8): only a range proven ends a gap.
    for (const [name, side, nowT] of [[HOME, homeSide, homeBefore], [PEER, peerSide, peerBefore]]) {
      const r = indexed[name];
      if (!r || r.failed) {
        if (side.gapSince !== undefined) heldKeys.add(`bridge-index-gap-${name}`);
        continue;
      }
      if (r.unchecked) await raise([{ level: "warn", key: `bridge-index-unchecked-${name}`, msg: `${name}: ${r.unchecked}` }]);
      if (r.reorg) await raise([{ level: r.reorg.deep ? "critical" : "warn", key: `bridge-reorg-${name}`, msg: `${name}: block ${r.reorg.at} the index held was replaced (a reorg): ${r.reorg.deep ? "deeper than every kept checkpoint, the side is read again from its first block" : `rewound to block ${r.reorg.to} and read again`}` }]);
      const stillGap = r.gap || ((r.idle || (r.partial && side.throughBlock < (side.gapAt ?? -1))) && side.gapSince !== undefined);
      if (stillGap) {
        side.gapSince ??= nowT;
        if (r.gap) side.gapAt = side.next;
        const held = nowT - side.gapSince;
        await raise([{ level: held >= unverifiedSeconds ? "critical" : "warn", key: `bridge-index-gap-${name}`, msg: `${name} bridge logs cannot be proven complete (${r.gap ?? "nothing new could be read this pass"}); the watcher stays at block ${side.throughBlock} and judges nothing past it${held > 0 ? ` (for ${held}s)` : ""}: fix the log RPC` }]);
      } else {
        delete side.gapSince;
        delete side.gapAt;
      }
    }
    const nowHome = homeSide.throughTime, nowPeer = peerSide.throughTime;
    const opts = { stuckWarnSeconds: W.stuckWarnSeconds, stuckCriticalSeconds: W.stuckCriticalSeconds, unverifiedSeconds };
    const both = W.directions !== "home";
    // A destination whose logs are unproven past its cursor: the gap alert speaks, a standing stuck alert is not cleared (#15).
    if (homeSide.gapSince !== undefined) heldPrefixes.push(`bridge-stuck-${PEER}-`);
    if (peerSide.gapSince !== undefined) heldPrefixes.push(`bridge-stuck-${HOME}-`);
    // peer -> home: mints at home (the forgery that matters to this chain). Judged on the saved peer index if the peer is unread.
    await raise(matchDirection({ src: peerSide, dst: homeSide, srcEid: EID[peerId], dstEid: EID[home], now: nowHome, srcNow: peerBefore ?? peerSide.throughTime, srcName: PEER, dstName: HOME, ...opts }).alerts);
    if (!peerUnread) {
      const c = laggedCounters(hist[HOME], { dstNow: BigNumber.from(homeReceived).add(homeQueued), srcSent: peerSent, now, lagSeconds, srcName: PEER, dstName: HOME });
      hist[HOME] = c.hist;
      await raise(c.alerts);
    } else heldKeys.add(`bridge-counters-${HOME}`);
    const vopts = { unverifiedSeconds };
    if (homeEndpoint) await raise(await verifiedAlerts({ src: peerSide, dst: homeSide, srcEid: EID[peerId], dstEid: EID[home], srcBridge: peerBridge.address, now: nowHome, srcName: PEER, dstName: HOME, readStored: (srcEid, sender, nonce) => epAt(home, provider, homeEndpoint).inboundPayloadHash(book.bridge.address, srcEid, sender, nonce), ...vopts }));
    if (both) {
      if (peerEndpoint && !peerUnread) await raise(await verifiedAlerts({ src: homeSide, dst: peerSide, srcEid: EID[home], dstEid: EID[peerId], srcBridge: book.bridge.address, now: nowPeer, srcName: HOME, dstName: PEER, readStored: (srcEid, sender, nonce) => epAt(peerId, peerProvider, peerEndpoint).inboundPayloadHash(peerBridge.address, srcEid, sender, nonce), ...vopts }));
      await raise(matchDirection({ src: homeSide, dst: peerSide, srcEid: EID[home], dstEid: EID[peerId], now: nowPeer, srcNow: homeBefore, srcName: HOME, dstName: PEER, ...opts }).alerts);
      if (!peerUnread) {
        const c = laggedCounters(hist[PEER], { dstNow: BigNumber.from(peerReceived).add(peerQueued), srcSent: homeSent, now, lagSeconds, srcName: HOME, dstName: PEER });
        hist[PEER] = c.hist;
        await raise(c.alerts);
      } else heldKeys.add(`bridge-counters-${PEER}`);
    }
    // Auto-claim on this chain only (its key is the only one this process holds). It needs only the home chain and the saved index.
    const claimHeld = new Set();
    try {
      await raise(await autoClaim(ctx, { side: homeSide, src: peerSide, srcEid: EID[peerId], dstEid: EID[home], name: HOME, W, held: claimHeld }));
    } catch (e) {
      complete = false;
      await raise([{ level: "warn", key: `bridge-claims-unread-${HOME}`, msg: `${HOME}: the auto-claim pass failed (${String(e.message).slice(0, 120)}); matured claims wait for the next pass` }]);
    }
    for (const k of claimHeld) heldKeys.add(k);
    // Paused paths, and tripped queue breakers (claims stop on the path; receipts and queueing go on). Unreadable = said, and held.
    for (const [name, br, eid, isPeer] of [[HOME, book.bridge, EID[peerId], false], [PEER, peerBridge, EID[home], true]]) {
      if (isPeer && peerUnread) {
        heldKeys.add(`bridge-paused-${name}`);
        heldKeys.add(`bridge-breaker-tripped-${name}`);
        continue;
      }
      let paused;
      try {
        paused = await br.paused(eid);
      } catch (e) {
        heldKeys.add(`bridge-paused-${name}`);
        await raise([{ level: "warn", key: `bridge-paused-unread-${name}`, msg: `the ${name} bridge's paused(${eid}) could not be read (${String(e.message).slice(0, 80)})` }]);
      }
      if (paused) await raise([{ level: "critical", key: `bridge-paused-${name}`, msg: `the ${name} bridge path to endpoint ${eid} is PAUSED (Safe act): only UNPAUSE (48 h) reopens it` }]);
      let tripped;
      try {
        tripped = await breakerTripped(br, eid);
      } catch (e) {
        tripped = `unreadable (${String(e.message).slice(0, 80)})`;
      }
      if (tripped) await raise([{ level: "critical", key: `bridge-breaker-tripped-${name}`, msg: `the ${name} bridge's queue breaker for endpoint ${eid} is ${tripped === true ? "TRIPPED: no claim on the path runs until the timelock's RESET_BREAKER (48 h) names this trip. Procedure: pause(eid) at once, cancelClaim every queued claim that matches no Sent, the VOID SWEEP before ANY reopening (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising the cap), PER NONCE: each payload the endpoint stores for the path against the peer's Sent at ITS OWN nonce; matching no honest Sent: voidPayload(hash); a REPLAY of an honest Sent from another nonce: hold + RELEASE(eid, nonce, 0) (a drop), never void, then one BATCH[RESET_BREAKER, UNPAUSE] through the timelock" : tripped}` }]);
    }
    // Supply equations. An unread supply keeps the standing supply alert (could-not-tell is not fine).
    const tol = BigInt(W.supplyToleranceWei ?? 10n ** 18n);
    const homeAddrs = { ledger: book.ledger.address, params: book.params.address, usd: book.usd.address, pegHook: book.pegHook?.address, migrator: book.record.migrator && book.record.migrator !== "0x0000000000000000000000000000000000000000" ? book.record.migrator : null };
    const sides = [[provider, homeAddrs, book.bridge, HOME, false]];
    if (W.peer.ledger && W.peer.params && W.peer.usd) sides.push([peerProvider, W.peer, peerBridge, PEER, true]);
    for (const [p, a, br, name, isPeer] of sides) {
      if (isPeer && peerUnread) {
        heldKeys.add(`bridge-supply-${name}`);
        continue;
      }
      try {
        const r = supplyCheck({ ...(await (ctx.readSupply ?? readSupply)(p, a, br)), toleranceWei: tol, name }); // ctx.readSupply: tests only
        log(`bridge  ${name} supply equation off by ${utils.formatEther(r.diff)}`);
        if (r.alert) await raise([r.alert]);
      } catch (e) {
        heldKeys.add(`bridge-supply-${name}`);
        await raise([{ level: "warn", key: `bridge-supply-unread-${name}`, msg: `${name}: the supply equation could not be read (${String(e.message).slice(0, 120)})` }]);
      }
    }
    log(`bridge  ${HOME} received ${utils.formatEther(homeReceived)} / sent ${utils.formatEther(homeSent)}; ${PEER} ${peerUnread ? "UNREAD" : `received ${utils.formatEther(peerReceived)} / sent ${utils.formatEther(peerSent)}`}; ${raisedKeys.size} alert(s)`);
    // Settle only after a pass that read everything it judges: a standing alert clears on a successful read, never on a failed one.
    if (complete) await ctx.alerts.settle("bridge-", (k) => raisedKeys.has(k) || heldKeys.has(k) || heldPrefixes.some((p) => k.startsWith(p)));
  } finally {
    save();
  }
}

export { chainOfEid };
