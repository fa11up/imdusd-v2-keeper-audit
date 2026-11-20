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
import { expandUrls } from "./chains.mjs";

const PINNED = new Set(["call", "getStorageAt", "getCode", "getBalance"]);
const RANGED = "getLogs"; // compared too, but only over an explicit numeric range (a "latest" range moves)

/** Every read has an explicit deadline and is never retried for long on a 429 (wave-5 audit, keeper.mjs:177): ethers' defaults are
 *  120 s per request and up to 12 backed-off retries, which let one slow RPC hold a pass for many minutes. READ_TIMEOUT_SECONDS. */
export const connection = (url, timeoutMs = 20_000) => ({ url, timeout: timeoutMs, throttleLimit: 2, throttleSlotInterval: 500 });

export class AgreeingProvider extends providers.StaticJsonRpcProvider {
  constructor(urls, chainId, { logUrls = null, maxSpread = 20, timeoutMs = 20_000 } = {}) {
    super(connection(urls[0], timeoutMs), chainId);
    this.others = urls.slice(1).map((u) => new providers.StaticJsonRpcProvider(connection(u, timeoutMs), chainId));
    this.logProviders = (logUrls ?? urls).map((u) => new providers.StaticJsonRpcProvider(connection(u, timeoutMs), chainId));
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

  /** The highest head any read RPC answers (wave-5 audit #1): a bound that must not be below the chain's real head takes the
   *  freshest node, not the first one. Throws only when none answers. */
  async maxHead() {
    const all = await Promise.allSettled([super.perform("getBlockNumber", {}), ...this.others.map((p) => p.perform("getBlockNumber", {}))]);
    const ok = all.filter((r) => r.status === "fulfilled").map((r) => Number(r.value));
    if (!ok.length) throw all[0].reason;
    // An RPC far above the others (internal review after wave 5: a wrong or hostile head) is dropped: never more than maxSpread past the lowest.
    const lo = Math.min(...ok);
    return Math.max(...ok.filter((h) => h <= lo + this.maxSpread));
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
    if (nodes.length === 1) {
      // One node (wave-5 audit #6): a transport error (a range it caps, a 429, a timeout) is `refused` as it is with two, so a
      // caller that halves a refused log range does so on a lone RPC too. A revert stays a revert.
      try {
        return await nodes[0](method, p);
      } catch (e) {
        if (revertData(e).startsWith("transport:")) e.refused = true;
        throw e;
      }
    }
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

/** The environment variable for `base` on this process's chain: `base` on mainnet (unchanged), `base_<chainId>` on any other chain, so a
 *  mainnet READ_RPC_URLS / SEND_RPC_URLS / DEPLOYMENT in the shell never reaches the 4663 process. */
export const envName = (cfg, base) => (Number(cfg?.CHAIN_ID ?? 1) === 1 ? base : `${base}_${Number(cfg.CHAIN_ID)}`);

/** A URL list from the environment (comma separated) or the config, `${NAME}` placeholders filled from the environment. */
export function urlList(cfg, base, env = process.env) {
  const raw = env[envName(cfg, base)]?.split(",") ?? cfg[base] ?? [];
  const { urls, missing } = expandUrls(raw, env);
  if (missing.length) console.log(`${base}: ${missing.length} URL(s) left out, ${[...new Set(missing)].join(", ")} not set`);
  return urls;
}

/** Reads for this process's chain. 4663: the public RPC rate-limits and keeps no archive; READ_RPC_URLS takes a paid node beside it
 *  (two agreeing), LOG_RPC_URLS may name a log-only door (Blockscout with BLOCKSCOUT_KEY): logs then never touch the read nodes. */
export function readProvider(cfg) {
  const urls = urlList(cfg, "READ_RPC_URLS");
  if (!urls.length) throw new Error(`${envName(cfg, "READ_RPC_URLS")} is empty`);
  const logUrls = urlList(cfg, "LOG_RPC_URLS");
  return new AgreeingProvider(urls, cfg.CHAIN_ID ?? 1, { logUrls: logUrls.length ? logUrls : urls, maxSpread: cfg.READ_MAX_SPREAD_BLOCKS ?? 20, timeoutMs: (cfg.READ_TIMEOUT_SECONDS ?? 20) * 1000 });
}

/** Read-only providers for the other chains this process reads (`PEERS[<id>] = { READ_RPC_URLS, LOG_RPC_URLS }`), keyed by chain id. */
export function peerProviders(cfg) {
  const out = {};
  for (const [id, p] of Object.entries(cfg.PEERS ?? {})) {
    const pc = { ...p, CHAIN_ID: Number(id) };
    // The peer's own env names: on the 4663 process, READ_RPC_URLS (mainnet's) is the mainnet peer's; on mainnet, READ_RPC_URLS_4663.
    const urls = urlList(pc, "READ_RPC_URLS");
    if (!urls.length) continue;
    const logUrls = urlList(pc, "LOG_RPC_URLS");
    out[Number(id)] = new AgreeingProvider(urls, Number(id), { logUrls: logUrls.length ? logUrls : urls, maxSpread: p.READ_MAX_SPREAD_BLOCKS ?? 20, timeoutMs: (p.READ_TIMEOUT_SECONDS ?? cfg.READ_TIMEOUT_SECONDS ?? 20) * 1000 });
  }
  return out;
}
