// Crash safety for sends. Before a signed transaction leaves, it is written here, keyed by nonce, and cleared only when the chain
// has settled that nonce; every step is also appended to state/journal.jsonl, the record of what was done and why.
//
// WHY. A send can outlast its wait (SEND_WAIT_SECONDS), and a private relay's transaction is invisible to the read RPCs. A restart in that window
// would re-decide from chain state that does not show the send yet, sign a second transaction on the same nonce and lose it to
// "replacement underpriced", or pay twice for a step that already went. Instead the next send settles the journal first.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stateDir, statePath } from "./state.mjs";

// One directory per signing key: nonces are per key, so the guardian's must never meet the keeper's.
const dir = (scope = "tx") => statePath(scope);
const file = (nonce, scope = "tx") => statePath(`${scope}/${nonce}.json`);

export function logStep(step, fields = {}) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(statePath("journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), step, ...fields })}\n`);
}

/** Written whole, before the transaction is broadcast: a crash leaves it recorded or never sent, not half of either. */
export function recordIntent({ nonce, hash, signed, label, at = new Date().toISOString() }, scope = "tx") {
  mkdirSync(dir(scope), { recursive: true });
  const p = file(nonce, scope);
  writeFileSync(`${p}.tmp`, JSON.stringify({ nonce, hash, signed, label, at }));
  renameSync(`${p}.tmp`, p);
  logStep("signed", { nonce, hash, label, scope });
}

export function clearIntent(nonce, step, fields = {}, scope = "tx") {
  rmSync(file(nonce, scope), { force: true });
  logStep(step, { nonce, scope, ...fields });
}

export const pendingIntents = (scope = "tx") => (existsSync(dir(scope)) ? readdirSync(dir(scope)).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(`${dir(scope)}/${f}`, "utf8"))) : []);

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
    await rebroadcast(it.signed).catch((e) => logStep("rebroadcast-failed", { hash: it.hash, why: String(e?.message ?? e).slice(0, 200) }));
    open.push(it);
  }
  return open;
}
