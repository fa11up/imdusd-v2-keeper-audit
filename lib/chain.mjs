// Reads that the RPCs must agree on, from the v1 keeper's Robinhood keeper.
//
// WHY. Every decision here (sample, liquidate, alert) is taken on chain state. One lagging or wrong node must not be able
// to make the keeper liquidate a healthy position or burn gas on samples. So every state read (eth_call, storage, code,
// balance) goes to EVERY read RPC at the SAME block, the lowest head among them, and the results must be identical; a
// disagreement throws and the loop does nothing this round. Head, receipts, gas and nonce use the first RPC.
// A node that does not answer (twice) is NOT a disagreement: it throws `refused` (the position index then halves its range).
//
// One URL is allowed (a fork test, or a node you run yourself) and then nothing is compared: `agree` reports it.
import { providers, utils } from "ethers";

const PINNED = new Set(["call", "getStorageAt", "getCode", "getBalance"]);
const RANGED = "getLogs"; // compared too, but only over an explicit numeric range (a "latest" range moves)

export class AgreeingProvider extends providers.StaticJsonRpcProvider {
  constructor(urls, chainId, { logUrls = null, maxSpread = 20 } = {}) {
    super(urls[0], chainId);
    this.others = urls.slice(1).map((u) => new providers.StaticJsonRpcProvider(u, chainId));
    this.logProviders = (logUrls ?? urls).map((u) => new providers.StaticJsonRpcProvider(u, chainId));
    this.urls = urls;
    this.logUrls = logUrls ?? urls;
    this._pin = null;
    this.maxSpread = maxSpread;
  }

  get agree() {
    return this.others.length > 0;
  }

  /** The block every pinned read uses: the lowest head among the RPCs, refreshed every 3 seconds. */
  async pinnedBlock() {
    if (this._pin && Date.now() - this._pin.at < 3000) return this._pin.n;
    const heads = await Promise.all([super.perform("getBlockNumber", {}), ...this.others.map((p) => p.perform("getBlockNumber", {}))]);
    const n = Math.min(...heads.map((h) => Number(h)));
    // One node stuck at an old block would pin every read to it, and the answers would still agree: refuse instead.
    const top = Math.max(...heads.map((h) => Number(h)));
    if (top - n > this.maxSpread) {
      const lagging = this.urls[heads.map((h) => Number(h)).indexOf(n)];
      const e = new Error(`read RPCs are ${top - n} blocks apart (${hostOf(lagging)} at ${n}, head ${top}): no reads until they agree`);
      e.refused = true;
      throw e;
    }
    this._pin = { n, at: Date.now() };
    return n;
  }

  /** Forget the pinned block (after sending a transaction, so the next reads see it). */
  unpin() {
    this._pin = null;
  }

  async perform(method, params) {
    const ranged = method === RANGED && typeof params.filter?.toBlock === "string" && /^0x[0-9a-f]+$/i.test(params.filter.toBlock);
    if (ranged) return this._agreed(method, params, this.logProviders.map((p) => (m, q) => p.perform(m, q)), this.logUrls, `blocks ${Number(params.filter.fromBlock)}-${Number(params.filter.toBlock)}`);
    if (!PINNED.has(method) || !this.agree) return super.perform(method, params);
    const p = { ...params };
    if (p.blockTag === undefined || p.blockTag === "latest" || p.blockTag === "pending") p.blockTag = utils.hexValue(await this.pinnedBlock());
    const all = [(m, q) => super.perform(m, q), ...this.others.map((o) => (m, q) => o.perform(m, q))];
    return this._agreed(method, p, all, this.urls, `block ${Number(p.blockTag)}`);
  }

  /** The same read from every node: one answer, or a refused / disagreement error. */
  async _agreed(method, p, nodes, urls, at) {
    if (nodes.length === 1) return nodes[0](method, p);
    const once = () => Promise.allSettled(nodes.map((n) => n(method, p)));
    let results = await once();
    const unanswered = (rs) => rs.findIndex((r) => r.status === "rejected" && revertData(r.reason).startsWith("transport:"));
    if (unanswered(results) >= 0) {
      await new Promise((r) => setTimeout(r, 500));
      results = await once();
    }
    const u = unanswered(results);
    if (u >= 0) {
      const e = new Error(`${hostOf(urls[u])} did not answer ${method} at ${at}: ${revertData(results[u].reason).slice(10)}`);
      e.refused = true;
      throw e;
    }
    // A revert must be the SAME revert everywhere.
    const norm = results.map((r) => (r.status === "fulfilled" ? `ok:${JSON.stringify(canonical(method, r.value))}` : `err:${revertData(r.reason)}`));
    if (norm.some((x) => x !== norm[0])) throw new Error(`read RPCs disagree on ${method} at ${at} (${urls.map(hostOf).join(" vs ")})`);
    if (results[0].status === "rejected") throw results[0].reason;
    return results[0].value;
  }
}

/** A URL as logs show it: the host only (a keyed URL's path holds the key). */
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** What two nodes must agree on: for logs, the fields that identify them (nodes add extras such as blockTimestamp). */
function canonical(method, v) {
  if (method !== RANGED || !Array.isArray(v)) return v;
  return v.map((l) => [l.blockNumber, l.transactionHash, l.logIndex, String(l.address).toLowerCase(), l.topics, l.data]);
}

/** The revert data of a failed call, or a marker that the call never reached a node. */
function revertData(e) {
  // ethers v5 turns ANY failed eth_call without revert data into CALL_EXCEPTION "missing revert data" (data "0x"),
  // a timeout included: look at what the node actually said before calling it a revert.
  if (e?.code === "CALL_EXCEPTION" && /missing revert data/.test(String(e.message)) && e.error) {
    const inner = e.error;
    const said = `${inner.message ?? ""} ${inner.body ?? ""} ${inner.error?.message ?? ""}`;
    if (!/revert/i.test(said)) return `transport:${String(inner.code ?? inner.message ?? "no answer").slice(0, 60)}`;
  }
  const d = e?.error?.data ?? e?.data ?? e?.error?.error?.data;
  if (typeof d === "string" && d.startsWith("0x")) return d;
  if (/revert/i.test(String(e?.message ?? ""))) return "revert";
  return `transport:${String(e?.code ?? e?.message ?? e).slice(0, 60)}`;
}

export function readProvider(cfg) {
  const list = (env, c) => (process.env[env]?.split(",") ?? c ?? []).map((u) => u.trim()).filter(Boolean);
  const urls = list("READ_RPC_URLS", cfg.READ_RPC_URLS);
  if (!urls.length) throw new Error("READ_RPC_URLS is empty");
  const logUrls = list("LOG_RPC_URLS", cfg.LOG_RPC_URLS);
  return new AgreeingProvider(urls, cfg.CHAIN_ID ?? 1, { logUrls: logUrls.length ? logUrls : urls, maxSpread: cfg.READ_MAX_SPREAD_BLOCKS ?? 20 });
}
