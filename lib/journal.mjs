// Crash safety for sends. Before a signed transaction leaves, it is written here, keyed by nonce, and cleared only when the chain
// has settled that nonce; every step is also appended to state/journal.jsonl, the record of what was done and why.
//
// WHY. A send can outlast its wait (SEND_WAIT_SECONDS), and a private relay's transaction is invisible to the read RPCs. A restart in that window
// would re-decide from chain state that does not show the send yet, sign a second transaction on the same nonce and lose it to
// "replacement underpriced", or pay twice for a step that already went. Instead the next send settles the journal first.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { StateUnreadable, stateDir, statePath, stopped, writeAtomic } from "./state.mjs";

// One directory per signing key: nonces are per key, so the guardian's must never meet the keeper's.
const dir = (scope = "tx") => statePath(scope);
const file = (nonce, scope = "tx") => statePath(`${scope}/${nonce}.json`);

export function logStep(step, fields = {}) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(statePath("journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), step, ...fields })}\n`);
}

/** Written whole, before the transaction is broadcast: a crash leaves it recorded or never sent, not half of either. */
export function recordIntent({ nonce, hash, signed, label, at = new Date().toISOString(), ...extra }, scope = "tx") {
  writeAtomic(file(nonce, scope), JSON.stringify({ nonce, hash, signed, label, at, ...extra }));
  logStep("signed", { nonce, hash, label, scope });
}

export function clearIntent(nonce, step, fields = {}, scope = "tx") {
  rmSync(file(nonce, scope), { force: true });
  logStep(step, { nonce, scope, ...fields });
}

/** Every open send. An intent file that cannot be read throws StateUnreadable: an open nonce is never read as none (audit wave 4, C9). */
export function pendingIntents(scope = "tx") {
  if (!existsSync(dir(scope))) return [];
  return readdirSync(dir(scope)).filter((f) => /^\d+\.json$/.test(f)).map((f) => {
    const name = `${scope}/${f}`;
    let it;
    try {
      it = JSON.parse(readFileSync(`${dir(scope)}/${f}`, "utf8"));
    } catch (e) {
      throw new StateUnreadable(name, e.code ?? "not JSON");
    }
    if (!it || it.nonce !== Number(f.slice(0, -5)) || typeof it.signed !== "string" || typeof it.hash !== "string") throw new StateUnreadable(name, "not { nonce, hash, signed }");
    return it;
  });
}

/** Every transaction hash this key ever signed here: the guardian tells the keeper's own sends from a stolen key's by this. */
export function signedHashes(scope = "tx") {
  const p = statePath("journal.jsonl");
  if (!existsSync(p)) return new Set();
  const out = new Set();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.includes('"signed"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.step === "signed" && (j.scope ?? "tx") === scope) out.add(String(j.hash).toLowerCase());
    } catch { /* a torn last line */ }
  }
  return out;
}

/**
 * Settle what a previous run left: mined, or its nonce was used by something else, clears it. Still open, the SAME signed bytes go out
 * again (same hash and nonce, so at most one copy is mined) and the caller waits. Returns the intents still open.
 */
export async function settleIntents(provider, address, rebroadcast, scope = "tx") {
  const open = [];
  for (const it of pendingIntents(scope)) {
    const rc = await provider.getTransactionReceipt(it.hash);
    if (rc) {
      clearIntent(it.nonce, rc.status === 0 ? "reverted" : "mined", { hash: it.hash, label: it.label, block: rc.blockNumber }, scope);
      continue;
    }
    if ((await provider.getTransactionCount(address, "latest")) > it.nonce) {
      clearIntent(it.nonce, "nonce-used-elsewhere", { hash: it.hash, label: it.label }, scope);
      continue;
    }
    // The kill switch holds rebroadcasts too (a review before wave 5b): receipts are still read and settled, nothing goes out.
    if (stopped()) logStep("rebroadcast-held", { hash: it.hash, why: "kill switch: state/STOP exists", scope });
    else await rebroadcast(it.signed).catch((e) => logStep("rebroadcast-failed", { hash: it.hash, why: String(e?.message ?? e).slice(0, 200) }));
    open.push(it);
  }
  return open;
}
