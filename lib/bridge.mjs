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
//            head, and once A is indexed through `srcBound` its absence proves a forgery. That is the next pass (A's log lag is 3
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
//            claimed like any other. Routine tier, urgent once the
//            user has waited `claimUrgentSeconds` (1 h) past maturity. NEVER an unmatched or unjudged one: the forged alert speaks
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
import { act } from "./act.mjs";
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
export const emptySide = (next) => ({ next, throughBlock: next - 1, throughTime: 0, sent: {}, received: {}, holds: {}, voids: {}, verified: {}, queue: {}, claimKey: {}, other: [] });

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
        out.push({ level: "critical", key: `bridge-forged-${dstName}-${nonce}`, msg: `${dstName} Received nonce ${nonce} (${utils.formatEther(r.amount)} to ${r.to}, guid ${r.guid}) does NOT match ${srcName}'s Sent at that nonce (${utils.formatEther(s.amount)} to ${recipientOf(s.to)}, guid ${s.guid}): FORGED. Safe: pause the path on ${srcName} and ${dstName}, hold/void what is waiting (tx ${r.tx})` });
      }
      continue;
    }
    if (r.srcBound !== undefined && src.throughBlock >= r.srcBound) {
      forged.push(nonce);
      out.push({ level: "critical", key: `bridge-forged-${dstName}-${nonce}`, msg: `${dstName} Received ${utils.formatEther(r.amount)} imdUSD to ${r.to} at nonce ${nonce} and ${srcName} never Sent that nonce (read through block ${src.throughBlock}): FORGED. Safe: pause both paths now, void every waiting forged payload (tx ${r.tx})` });
    } else if (now - r.time > unverifiedSeconds) {
      out.push({ level: "critical", key: `bridge-unverified-${dstName}-${nonce}`, msg: `${dstName} Received nonce ${nonce} ${now - r.time}s ago and ${srcName} has not been read past it (through ${src.throughBlock}, needs ${r.srcBound ?? "a read after it"}): the watcher cannot prove it honest` });
    }
  }
  // Queued transfers (inbound delay): judged like a Received, before anything is minted. The Safe's window is until claimableAt.
  for (const [key, q] of Object.entries(dst.queue ?? {})) {
    const [eid, nonce] = key.split(":");
    const j = Number(eid) !== Number(srcEid) ? { verdict: "forged" } : judgeQueued(q, nonce, src, dstEid);
    // Claimable at queuedAt + the delay in force (the last DelaySet indexed; Queued's own claimableAt before any).
    const queuedAt = q.queuedAt ?? q.time;
    const d = dst.delays?.[String(eid)];
    const at = new Date((queuedAt + (d ? d.delay : q.claimableAt - queuedAt)) * 1000).toISOString();
    const cut = d && d.cancelFrom !== 0 && queuedAt >= d.cancelFrom;
    const calls = `Safe on ${dstName}: pause(${eid}) on the ${dstName} bridge NOW (stops every claim on the path), then cancelClaim(${eid}, ${q.guid}); or tighten(${eid}, <cap>, <delay>, <breaker>, ${queuedAt}) to cancel every claim queued since, in one act${cut ? ` (a cutoff at ${d.cancelFrom} already holds it)` : ""}`;
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
      out.push({ level: "critical", key: `bridge-held-${dstName}-${nonce}`, msg: `${dstName}'s Safe holds nonce ${nonce} from ${srcName} (${utils.formatEther(s.amount)} imdUSD) until ${new Date(hold.until * 1000).toISOString()}${hold.payloadHash === hash ? "" : `; the held payload ${hold.payloadHash} is NOT the Sent one ${hash}`}: it runs for anyone after that unless voided` });
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
    out.push({ level: "critical", key: `bridge-held-${dstName}-${nonce}`, msg: `${dstName}'s Safe holds a payload at nonce ${nonce} from endpoint ${eid} that ${srcName} never sent (${h.payloadHash}): a forgery under hold until ${new Date(h.until * 1000).toISOString()}; void it before then` });
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
      const why = s ? `${srcName} Sent a DIFFERENT payload at that nonce (${payloadHashOf(s)}, ${utils.formatEther(s.amount)} imdUSD to ${recipientOf(s.to)}): a forgery over an honest transfer` : `${srcName} never sent that nonce (read through block ${src.throughBlock})`;
      const stored = ran ? lc(utils.hexZeroPad("0x", 32)) : await readStored(Number(eid), v.sender, Number(nonce)).catch(() => null);
      if (stored !== null && lc(stored) === hash) {
        out.push({ level: "critical", key: `bridge-verified-forged-${dstName}-${nonce}`, msg: `${dstName}'s endpoint holds a FORGED packet for our bridge at nonce ${nonce} from endpoint ${eid}, verified (tx ${v.tx}) and NOT YET EXECUTED: it waits at the endpoint. ${why}. Safe on ${dstName}: hold(${eid}, ${nonce}) or voidPayload(${hash}) NOW, then pause the path on both chains. Anyone may run it the moment it can execute` });
      } else if (stored === null) {
        out.push({ level: "critical", key: `bridge-verified-forged-${dstName}-${nonce}`, msg: `${dstName}'s endpoint verified a FORGED packet for our bridge at nonce ${nonce} (payload ${hash}, tx ${v.tx}); whether it still waits there could not be read. ${why}. Safe on ${dstName}: voidPayload(${hash}) and pause both paths` });
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

/** Stamp every Received on `side` not yet stamped with `bound`: the OTHER chain's head, read after `side` was indexed. */
export function stampBounds(side, bound) {
  for (const r of Object.values(side.received)) if (r.srcBound === undefined) r.srcBound = bound;
  for (const q of Object.values(side.queue ?? {})) if (q.srcBound === undefined) q.srcBound = bound;
  for (const byHash of Object.values(side.verified ?? {})) for (const v of Object.values(byHash)) if (v.srcBound === undefined) v.srcBound = bound;
  return side;
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

/**
 * Index one side's bridge logs from its cursor to head - lag. A refused range is halved (the 4663 public RPC caps ranges).
 * Fixed before audit wave 5: NOTHING IS MARKED READ UNTIL IT IS PROVEN COMPLETE. Each range is read until two reads agree (readAgreed), the
 * events are held back, and the cursor moves only once the bridge's own counters at the block read through equal the counters at the
 * last proven block plus the held-back Sent and Received amounts (`side.counted`). A log RPC that answers [] for a range holding a
 * Sent or Received therefore cannot advance the cursor past it: the walk is retried once, then the cursor stays where it was and the
 * result says `gap` (runBridge alerts). Holds and voids are covered by the agreeing reads only (no counter moves with them).
 * Returns { gap, unchecked }.
 */
/** The path's delay settings at `block` ({ delay, cancelFrom }), or null when the bridge has no breakers view (a test fake). */
async function settingsAt(provider, bridge, eid, block) {
  if (typeof bridge.breakers !== "function") return null;
  if (block < 0 || (provider.getCode && (await provider.getCode(bridge.address, block)) === "0x")) return { delay: 0, cancelFrom: 0 };
  const b = await bridge.breakers(eid, { blockTag: block });
  return { delay: Number(b.delay ?? b[4]), cancelFrom: Number(b.cancelledFrom ?? b[5]) };
}

export async function indexSide(provider, bridge, side, { lag = 3, chunk = 9_000, minChunk = 500, maxReads = 4, walks = 2 } = {}, endpoint = null, settingsEid = null) {
  const head = await provider.getBlockNumber();
  const top = head - lag;
  if (side.next > top) return {};
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
  let why = null;
  for (let walk = 0; walk < walks; walk++) {
    let next = side.next, size = chunk;
    const events = [];
    why = null;
    while (next <= top) {
      const to = Math.min(top, next + size - 1);
      let logs;
      try {
        logs = await readAgreed(provider, { address: bridge.address, fromBlock: next, toBlock: to }, maxReads);
      } catch (e) {
        if (!e.refused || size <= minChunk) throw e;
        size = Math.floor(size / 2);
        continue;
      }
      // Pre-fix 3: the endpoint's PacketVerified for OUR bridge, same range, same agreeing reads (receiver is not indexed: filtered here).
      let epLogs = [];
      if (logs !== null && endpoint) {
        try {
          epLogs = await readAgreed(provider, { address: endpoint, topics: [verifiedTopic], fromBlock: next, toBlock: to }, maxReads);
        } catch (e) {
          if (!e.refused || size <= minChunk) throw e;
          size = Math.floor(size / 2);
          continue;
        }
      }
      if (logs === null || epLogs === null) {
        why = `${maxReads} reads of blocks ${next}-${to} never agreed`;
        break;
      }
      const times = new Map();
      const at = async (n) => {
        if (!times.has(n)) times.set(n, (await provider.getBlock(n)).timestamp);
        return times.get(n);
      };
      for (const l of logs) {
        let p;
        try { p = iface.parseLog(l); } catch { continue; }
        events.push({ name: p.name, args: p.args, blockNumber: l.blockNumber, transactionHash: l.transactionHash, time: await at(l.blockNumber) });
      }
      for (const l of epLogs) {
        let p;
        try { p = epIface.parseLog(l); } catch { continue; }
        if (lc(p.args.receiver) !== lc(bridge.address)) continue;
        events.push({ name: p.name, args: p.args, blockNumber: l.blockNumber, transactionHash: l.transactionHash, time: await at(l.blockNumber) });
      }
      next = to + 1;
    }
    const through = next - 1;
    if (through < side.next) continue;
    const t = totalsOf(events, side);
    // DelaySet moves no counter: the settings the index would hold after these events must be the chain's at `through`.
    const known = settingsEid !== null ? side.delays?.[String(settingsEid)] : undefined;
    if (known) {
      const last = events.filter((e) => e.name === "DelaySet" && Number(e.args.srcEid) === Number(settingsEid)).at(-1);
      const want = last ? { delay: Number(last.args.delay), cancelFrom: Number(last.args.cancelFrom) } : known;
      const st = await settingsAt(provider, bridge, settingsEid, through);
      if (st && (st.delay !== want.delay || st.cancelFrom !== want.cancelFrom)) {
        why = `blocks ${side.next}-${through}: the logs read leave the path's delay ${want.delay} s / cutoff ${want.cancelFrom}, the bridge says ${st.delay} s / ${st.cancelFrom}: a DelaySet is missing`;
        continue; // read the whole walk again; nothing was folded
      }
    }
    if (side.counted) {
      const now = await countersAt(provider, bridge, through);
      const wantSent = BigNumber.from(side.counted.sent).add(t.sent), wantReceived = BigNumber.from(side.counted.received).add(t.received);
      if (!wantSent.eq(now.sent) || !wantReceived.eq(now.received)) {
        why = `blocks ${side.next}-${through}: the logs read hold sent ${utils.formatEther(wantSent)} / received ${utils.formatEther(wantReceived)}, the bridge counters say ${utils.formatEther(now.sent)} / ${utils.formatEther(now.received)}`;
        continue; // read the whole walk again; nothing was folded
      }
      // The queue: a Queued, Claimed, cancel or restore hidden by an empty log answer breaks this equation as a Sent or Received does.
      if (side.counted.queued !== undefined && now.queued !== undefined) {
        if (t.queued === null) unchecked = `blocks ${side.next}-${through}: a claim was cancelled or restored whose Queued is before the watcher's first block, so the queued counter is taken without the proof`;
        else if (!BigNumber.from(side.counted.queued).add(t.queued).eq(now.queued)) {
          why = `blocks ${side.next}-${through}: the logs read hold queued ${utils.formatEther(BigNumber.from(side.counted.queued).add(t.queued))}, the bridge counter says ${utils.formatEther(now.queued)}`;
          continue;
        }
      }
      side.counted = now;
    } else {
      // No proven start (unchecked): fold, and prove every later range from the counters read here.
      try { side.counted = await countersAt(provider, bridge, through); } catch { /* still unchecked next pass */ }
    }
    addEvents(side, events);
    side.next = through + 1;
    side.throughBlock = through;
    side.throughTime = (await provider.getBlock(through)).timestamp;
    if (!why) return { unchecked };
  }
  return { gap: why, unchecked };
}

export async function readSupply(provider, a, bridge) {
  const c = (x, abi) => new Contract(x, abi, provider);
  const ledger = c(a.ledger, LEDGER_4663_ABI), params = c(a.params, PARAMS_ABI);
  const n = (await params.ilkCount()).toNumber();
  const states = await Promise.all([...Array(n).keys()].map(async (i) => ledger.ilkState(await params.ilks(i))));
  const zero = BigNumber.from(0);
  const [totalSupply, reserveBacked, migrator, pegKeeper, received, sent] = await Promise.all([
    c(a.usd, SUPPLY_ABI).totalSupply(), ledger.reserveBacked(),
    a.migrator ? c(a.migrator, SUPPLY_ABI).outstanding() : zero, a.pegHook ? c(a.pegHook, PEG_HOOK_ABI).outstanding() : zero,
    bridge.received(), bridge.sent(),
  ]);
  return { totalSupply, debts: states.map((s) => s.debt), badDebts: states.map((s) => s.badDebt), reserveBacked, migrator, pegKeeper, received, sent };
}

/** The send label of a claim: the journal finds a claim's sends by it, across restarts. */
export const claimLabel = (srcEid, guid) => `bridge claim ${Number(srcEid)}:${lc(guid)}`;

/** From the send journal: the claim labels with a send still open (its own intent, or a cancel/replacement of it), and every hash ever
 *  signed per claim label. */
function claimJournal(scope) {
  const open = new Set();
  for (const it of pendingIntents(scope)) for (const l of [it.label, it.cancelOf]) if (typeof l === "string" && l.startsWith("bridge claim ")) open.add(l);
  const signed = new Map();
  const p = statePath("journal.jsonl");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.includes('"bridge claim ')) continue;
      try {
        const j = JSON.parse(line);
        if (j.step === "signed" && (j.scope ?? "tx") === scope && String(j.label).startsWith("bridge claim ")) {
          if (!signed.has(j.label)) signed.set(j.label, []);
          signed.get(j.label).push(j.hash);
        }
      } catch { /* a torn last line */ }
    }
  }
  return { open, signed };
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
export async function autoClaim(ctx, { side, src, srcEid, dstEid, name, W = {} }) {
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
    if (settle) await settle();
  }
  const journal = ctx.execute ? claimJournal(scope) : { open: new Set(), signed: new Map() };
  const urgentAfter = W.claimUrgentSeconds ?? 3600;
  for (const [nonce, q] of due) {
    const label = claimLabel(srcEid, q.guid);
    // P3: a send of this claim still open (or its replacement or cancel): wait for it. One the journal shows mined: done.
    if (journal.open.has(label)) continue;
    let mined = null;
    for (const h of journal.signed.get(label) ?? []) {
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
    const r = await act(ctx, label, bridge, "claim", [srcEid, q.guid], { tier: late > urgentAfter ? "urgent" : "routine" });
    if (r?.hash) continue; // mined: its Claimed arrives with the logs
    const why = r?.refused ?? r?.skipped ?? (r?.pending ? `sent ${r.pending}, not mined yet` : null);
    if (r?.refused && CUT.test(r.refused)) continue; // a cutoff set between the read and the simulation: held, the info alert speaks next pass
    if (r?.refused && CLOSED.test(r.refused)) out.push({ level: "critical", key: `bridge-claims-closed-${name}`, msg: `${name}: claim ${q.guid} (nonce ${nonce}) refused: ${r.refused}. The path from endpoint ${srcEid} is closed to claims` });
    else if (r?.refused && !r.watch) out.push({ level: "warn", key: `bridge-claim-refused-${name}-${nonce}`, msg: `${name}: claim of nonce ${nonce} (${utils.formatEther(q.amount)} imdUSD to ${q.to}) refused in simulation: ${r.refused}` });
    if (late > urgentAfter && ctx.execute && !r?.pending) out.push({ level: "warn", key: `bridge-claim-late-${name}-${nonce}`, msg: `${name}: ${utils.formatEther(q.amount)} imdUSD to ${q.to} (nonce ${nonce}) matured ${Math.round(late / 60)} min ago and is not claimed${why ? `: ${why}` : ""}` });
  }
  return out;
}

/**
 * Startup check (auto-claim): on mainnet the bridge loop runs only with BRIDGE_WATCH.enabled, and only the keeper of a chain
 * can claim there. A record that names a bridge with the watcher off means transfers queued on mainnet are never auto-claimed: say
 * so. Returns the message, or null.
 */
export function bridgeWatchOff(cfg, record) {
  if (Number(cfg.CHAIN_ID ?? 1) !== 1) return null; // the 4663 keeper always runs the bridge loop
  const b = record?.bridge;
  if (!b || /^0x0{40}$/i.test(b) || cfg.BRIDGE_WATCH?.enabled) return null;
  return `the deployment names a bridge (${b}) but BRIDGE_WATCH.enabled is off on mainnet: transfers queued on mainnet (4663 -> mainnet above the instant cap) are NOT auto-claimed and no forged Queued on mainnet is watched. Set BRIDGE_WATCH.enabled with PEERS[4663] and BRIDGE_WATCH.peer.bridge`;
}

/** Where a page to the Safe signers would go. PLACEHOLDER: no paging code; alerts.mjs already sends Telegram. */
function page(/* alert */) {
  // Not built: page the Safe signers for every critical bridge alert.
}

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
  const file = "bridge-watch.json";
  const s = readStateOr(file, {});
  const homeSide = s.home && s.home.bridge === lc(book.bridge.address) ? s.home : { ...emptySide(Number(W.fromBlock ?? book.record.deployBlock ?? 0)), bridge: lc(book.bridge.address) };
  const peerSide = s.peer && s.peer.bridge === lc(peerBridge.address) ? s.peer : { ...emptySide(Number(W.peer.fromBlock ?? 0)), bridge: lc(peerBridge.address) };
  // Counters first, each destination before its source (see counterAlerts), then the logs.
  // `received` before `queued` on each destination (a claim moves an amount from queued to received: never counted twice).
  const queuedOf = async (br) => (typeof br.queued === "function" ? br.queued() : BigNumber.from(0));
  const homeReceived = await book.bridge.received();
  const homeQueued = await queuedOf(book.bridge);
  const peerSent = await peerBridge.sent();
  const peerReceived = await peerBridge.received();
  const peerQueued = await queuedOf(peerBridge);
  const homeSent = await book.bridge.sent();
  // One clock per comparison (see ONE CLOCK above): each chain's head time read BEFORE either side is indexed, for the stuck ages.
  const timeOfHead = async (p) => (await p.getBlock(await p.getBlockNumber())).timestamp;
  const homeBefore = await timeOfHead(provider), peerBefore = await timeOfHead(peerProvider);
  // Each chain's EndpointV2: from config, else the bridge's own immutable `endpoint()`, kept in the side's state.
  const endpointOf = async (side, br, configured) => {
    if (W.watchVerified === false) return null;
    if (!side.endpoint) side.endpoint = configured ? lc(configured) : typeof br.endpoint === "function" ? lc(await br.endpoint()) : null;
    return side.endpoint;
  };
  const homeEndpoint = await endpointOf(homeSide, book.bridge, W.endpoint), peerEndpoint = await endpointOf(peerSide, peerBridge, W.peer.endpoint);
  const indexed = {
    [names[home]]: await indexSide(provider, book.bridge, homeSide, W.homeLogs ?? cfg.LOGS, homeEndpoint, EID[peerId]),
    [names[peerId]]: await indexSide(peerProvider, peerBridge, peerSide, W.peerLogs ?? {}, peerEndpoint, EID[home]),
  };
  // ...and each chain's head block read AFTER both sides are indexed: every Sent behind a Received just read is at or below it.
  stampBounds(peerSide, await provider.getBlockNumber());
  stampBounds(homeSide, await peerProvider.getBlockNumber());

  const raised = [];
  // A range the logs could not prove: the cursor stays before it, so nothing in it is judged yet. Warn at once; critical once
  // it has held the cursor `unverifiedSeconds` (that side's own clock): a destination blind that long could be hiding a forged mint.
  for (const [name, side, nowT] of [[names[home], homeSide, homeBefore], [names[peerId], peerSide, peerBefore]]) {
    const r = indexed[name];
    if (r.unchecked) raised.push({ level: "warn", key: `bridge-index-unchecked-${name}`, msg: `${name}: ${r.unchecked}` });
    if (r.gap) {
      side.gapSince ??= nowT;
      const held = nowT - side.gapSince;
      raised.push({ level: held >= (W.unverifiedSeconds ?? 1800) ? "critical" : "warn", key: `bridge-index-gap-${name}`, msg: `${name} bridge logs cannot be proven complete (${r.gap}); the watcher stays at block ${side.throughBlock} and judges nothing past it${held > 0 ? ` (for ${held}s)` : ""}: fix the log RPC` });
    } else delete side.gapSince;
  }
  writeState(file, { home: homeSide, peer: peerSide });
  const nowHome = homeSide.throughTime, nowPeer = peerSide.throughTime;
  const opts = { stuckWarnSeconds: W.stuckWarnSeconds, stuckCriticalSeconds: W.stuckCriticalSeconds, unverifiedSeconds: W.unverifiedSeconds };
  const both = W.directions !== "home";
  // peer -> home: mints at home (the forgery that matters to this chain).
  raised.push(...matchDirection({ src: peerSide, dst: homeSide, srcEid: EID[peerId], dstEid: EID[home], now: nowHome, srcNow: peerBefore, srcName: names[peerId], dstName: names[home], ...opts }).alerts);
  raised.push(...counterAlerts({ dstReceived: homeReceived, dstQueued: homeQueued, srcSent: peerSent, srcName: names[peerId], dstName: names[home] }));
  // Verified-but-not-run packets: read the endpoint that holds them, on the destination's own chain.
  const storedReader = (chainId, p, endpoint, receiver) => (srcEid, sender, nonce) =>
    (ctx.endpointAt?.(chainId) ?? new Contract(endpoint, ENDPOINT_ABI, p)).inboundPayloadHash(receiver, srcEid, sender, nonce); // ctx.endpointAt: tests only
  const vopts = { unverifiedSeconds: W.unverifiedSeconds };
  if (homeEndpoint) raised.push(...(await verifiedAlerts({ src: peerSide, dst: homeSide, srcEid: EID[peerId], dstEid: EID[home], srcBridge: peerBridge.address, now: nowHome, srcName: names[peerId], dstName: names[home], readStored: storedReader(home, provider, homeEndpoint, book.bridge.address), ...vopts })));
  if (both && peerEndpoint) raised.push(...(await verifiedAlerts({ src: homeSide, dst: peerSide, srcEid: EID[home], dstEid: EID[peerId], srcBridge: book.bridge.address, now: nowPeer, srcName: names[home], dstName: names[peerId], readStored: storedReader(peerId, peerProvider, peerEndpoint, peerBridge.address), ...vopts })));
  if (both) {
    raised.push(...matchDirection({ src: homeSide, dst: peerSide, srcEid: EID[home], dstEid: EID[peerId], now: nowPeer, srcNow: homeBefore, srcName: names[home], dstName: names[peerId], ...opts }).alerts);
    raised.push(...counterAlerts({ dstReceived: peerReceived, dstQueued: peerQueued, srcSent: homeSent, srcName: names[home], dstName: names[peerId] }));
  }
  // Auto-claim on this chain only (its key is the only one this process holds). The peer chain's keeper claims there.
  raised.push(...(await autoClaim(ctx, { side: homeSide, src: peerSide, srcEid: EID[peerId], dstEid: EID[home], name: names[home], W })));
  writeState(file, { home: homeSide, peer: peerSide });
  // Paused paths, and tripped queue breakers (claims stop on the path; receipts and queueing go on).
  for (const [name, br, eid] of [[names[home], book.bridge, EID[peerId]], [names[peerId], peerBridge, EID[home]]]) {
    if (await br.paused(eid)) raised.push({ level: "critical", key: `bridge-paused-${name}`, msg: `the ${name} bridge path to endpoint ${eid} is PAUSED (Safe act): only UNPAUSE (48 h) reopens it` });
    let tripped;
    try {
      tripped = await breakerTripped(br, eid);
    } catch (e) {
      tripped = `unreadable (${String(e.message).slice(0, 80)})`;
    }
    if (tripped) raised.push({ level: "critical", key: `bridge-breaker-tripped-${name}`, msg: `the ${name} bridge's queue breaker for endpoint ${eid} is ${tripped === true ? "TRIPPED: no claim on the path runs until the timelock's RESET_BREAKER (48 h) names this trip. Check every queued claim against its Sent before releasing" : tripped}` });
  }
  // Supply equations.
  const tol = BigInt(W.supplyToleranceWei ?? 10n ** 18n);
  const homeAddrs = { ledger: book.ledger.address, params: book.params.address, usd: book.usd.address, pegHook: book.pegHook?.address, migrator: book.record.migrator && book.record.migrator !== "0x0000000000000000000000000000000000000000" ? book.record.migrator : null };
  const sides = [[provider, homeAddrs, book.bridge, names[home]]];
  if (W.peer.ledger && W.peer.params && W.peer.usd) sides.push([peerProvider, W.peer, peerBridge, names[peerId]]);
  for (const [p, a, br, name] of sides) {
    try {
      const r = supplyCheck({ ...(await (ctx.readSupply ?? readSupply)(p, a, br)), toleranceWei: tol, name }); // ctx.readSupply: tests only
      log(`bridge  ${name} supply equation off by ${utils.formatEther(r.diff)}`);
      if (r.alert) raised.push(r.alert);
    } catch (e) {
      raised.push({ level: "warn", key: `bridge-supply-unread-${name}`, msg: `${name}: the supply equation could not be read (${String(e.message).slice(0, 120)})` });
    }
  }
  log(`bridge  ${names[home]} received ${utils.formatEther(homeReceived)} / sent ${utils.formatEther(homeSent)}; ${names[peerId]} received ${utils.formatEther(peerReceived)} / sent ${utils.formatEther(peerSent)}; ${raised.length} alert(s)`);
  for (const a of raised) {
    if (a.level === "critical") page(a);
    await ctx.alerts.raise(a.level, a.key, a.msg);
  }
  // An unread supply keeps the standing supply alert (could-not-tell is not fine).
  const unreadSupply = raised.filter((a) => a.key.startsWith("bridge-supply-unread-")).map((a) => a.key.replace("-unread", ""));
  await ctx.alerts.settle("bridge-", new Set([...raised.map((a) => a.key), ...unreadSupply]));
}

export { chainOfEid };
