// Every position there will ever be: the Ledger's `Opened(id, ilk, owner, salt)` events since its deploy block, kept in state/.
// SortedPositions is not enough: it lists only redeemable types.
//
// AN RPC THAT SILENTLY RETURNS NOTHING (v1, 2026-10-04: publicnode returned an empty range that held a depositor) is the failure
// that matters. So every range goes to all LOG_RPC_URLS and must agree (lib/chain.mjs), and the index is PROVEN COMPLETE against
// the chain: per type, the collateral of every indexed position must add up to the Ledger's `ilkState(ilk).collateral`. A shortfall
// means a position is missing: rebuild from the deploy block once, then say so loudly and act on what is known.
// A range a node refuses is split in half until it is accepted.
import { BigNumber, utils } from "ethers";
import { readStateOr, writeState } from "./state.mjs";

const OPENED = utils.id("Opened(uint256,bytes32,address,uint256)");
const name = (ledger) => `index-${ledger.toLowerCase()}.json`;

export function addLogs(s, logs) {
  for (const l of logs) {
    if (l.topics[0] !== OPENED) continue;
    const id = BigNumber.from(l.topics[1]).toString();
    const ilk = l.topics[2].toLowerCase();
    const list = (s.ids[ilk] ??= []);
    if (!list.includes(id)) list.push(id);
  }
}

const inflight = new Map(); // file -> the refresh running for it: concurrent callers share it (a review before wave 5b)

/** Bring the index file up to head - lag. Single-flight per file; each chunk is written atomically (lib/state.mjs writeState: temp +
 *  fsync + rename) after it is read, so a crash keeps every chunk read before it. */
export function refreshIndex(provider, ledger, fromBlock, opts = {}) {
  const file = name(ledger);
  if (inflight.has(file)) return inflight.get(file);
  const p = refreshOnce(provider, ledger, fromBlock, opts).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

async function refreshOnce(provider, ledger, fromBlock, { chunk = 9_000, lag = 3 } = {}) {
  const file = name(ledger);
  const saved = readStateOr(file, null);
  const s = saved && saved.fromBlock === fromBlock ? saved : { fromBlock, next: fromBlock, ids: {} };
  const top = (provider.pinnedBlock ? await provider.pinnedBlock() : await provider.getBlockNumber()) - lag;
  let size = chunk;
  while (s.next <= top) {
    const to = Math.min(top, s.next + size - 1);
    let logs;
    try {
      logs = await provider.getLogs({ address: ledger, topics: [OPENED], fromBlock: s.next, toBlock: to });
    } catch (e) {
      if (!e.refused || size <= 500) throw e; // a disagreement is never retried smaller
      size = Math.floor(size / 2);
      continue;
    }
    addLogs(s, logs);
    s.next = to + 1;
    writeState(file, s);
  }
  return { ids: s.ids, top };
}

export function resetIndex(ledger) {
  if (inflight.has(name(ledger))) throw new Error(`resetIndex(${ledger}) while a refresh of it runs`); // never under a refresh
  writeState(name(ledger), null);
}

/** Per type at `blockTag`, the block the index reached (a position opened after it is in the total and not yet in the index): indexed collateral vs the Ledger's total. [{ ilk, indexed, total }] for every type that does not add up. */
export async function shortfalls(book, ids, blockTag) {
  const out = [];
  for (const t of book.ilks) {
    const list = ids[t.id.toLowerCase()] ?? [];
    const [state, ...pos] = await Promise.all([book.ledger.ilkState(t.id, { blockTag }), ...list.map((id) => book.ledger.position(id, { blockTag }))]);
    const indexed = pos.reduce((a, p) => a.add(p.collateral), BigNumber.from(0));
    if (!indexed.eq(state.collateral)) out.push({ ilk: t.name, indexed: indexed.toString(), total: state.collateral.toString() });
  }
  return out;
}
