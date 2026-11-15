// Which IdentityMD control-plane server to talk to, and whether it is answering oracle requests at all (carried over from the v1 keeper).
//
// WHY. On 2026-10-23 the plane's domain was put on a registrar hold for ten hours and 3.5 IMD went on updates it could never answer.
// So: servers from ENS first (identitymd.eth, text record imd.servers: a registrar cannot suspend it), and no buying while the
// plane's newest settled requests were all blocked. Holding costs only time; buying into a failing plane costs 0.5 IMD per answer.
const ENS_NAME = "identitymd.eth";
const ENS_KEY = "imd.servers";
const SETTLED = new Set(["attested", "disagreed", "blocked", "mismatch"]);

const clean = (u) => String(u).trim().replace(/\/+$/, "");
const isHttps = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(u);

async function getJson(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function ensServers(provider) {
  try {
    const resolver = await provider.getResolver(ENS_NAME);
    const text = resolver ? await resolver.getText(ENS_KEY) : null;
    return (text ?? "").split(",").map(clean).filter(isHttps);
  } catch {
    return [];
  }
}

/** ENS first, then the config's own. PLANE.useEns false (tests) never reads ENS, so a mock server is the only server. */
export async function planeServers(provider, cfg) {
  const configured = [cfg.API_BASE, ...(cfg.API_FALLBACKS ?? [])].filter(Boolean).map(clean);
  const ens = cfg.PLANE?.useEns === false ? [] : await ensServers(provider);
  return [...new Set([...ens, ...configured])];
}

/** { base, ok, why, servers }: `base` null when no server answers /health; `ok` false when buying now is unwise. */
export async function plane(provider, cfg, fetchImpl = fetch) {
  const servers = await planeServers(provider, cfg);
  const timeoutMs = cfg.PLANE?.timeoutMs ?? 8000;
  let base = null;
  for (const s of servers) {
    try {
      const h = await getJson(`${s}/health`, fetchImpl, timeoutMs);
      if (h?.status === "ok") { base = s; break; }
    } catch { /* next server */ }
  }
  if (!base) return { base: null, ok: false, why: `no plane server answers /health (tried ${servers.join(", ") || "none"})`, servers };
  const n = cfg.PLANE?.holdAfterBlocked ?? 3;
  if (!n) return { base, ok: true, why: "", servers };
  try {
    const body = await getJson(`${base}/oracle/requests?limit=25`, fetchImpl, timeoutMs);
    const settled = (body.requests ?? []).filter((r) => SETTLED.has(r.status)).slice(0, n);
    if (settled.length === n && settled.every((r) => r.status === "blocked")) {
      return { base, ok: false, why: `the plane's last ${n} settled oracle requests were all blocked (newest ${settled[0].createdAt})`, servers };
    }
  } catch (e) {
    return { base, ok: false, why: `${base}/oracle/requests could not be read (${e.message})`, servers };
  }
  return { base, ok: true, why: "", servers };
}

/** The network health index exactly as the NHI body defines it, from one read of /swarm (as the v1 keeper computes it). */
export function nhiFromSwarm(doc) {
  const WAD = 10n ** 18n;
  const h = doc.health ?? {};
  const js = doc.counts?.jobStates ?? {};
  const n = (x) => BigInt(Math.trunc(Number(x ?? 0)));
  let p = n(h.seatsEnrolled) === 0n ? 0n : (n(h.agentsOnline) * WAD) / n(h.seatsEnrolled);
  if (p > WAD) p = WAD;
  const u = [h.verifierUp, h.publisherUp, h.deployerUp].filter((x) => x === true).length;
  const s = (BigInt(u) * WAD) / 3n;
  const d = n(js.completed), b = n(js.blocked) + n(js.cancelled);
  const r = d + b === 0n ? WAD : (d * WAD) / (d + b);
  return (4n * p + 3n * s + 3n * r) / 10n;
}

/** One live read, or null when the plane cannot be read. */
export async function readLiveNhi(base, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${base}/swarm`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    return res.ok ? nhiFromSwarm(await res.json()) : null;
  } catch {
    return null;
  }
}
