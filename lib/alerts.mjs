// Alerts: always the log and state/alerts.jsonl; Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set. Each key fires once,
// again after its repeat interval while it holds, AT ONCE when its level rises (warn -> critical: wave-5 audit), again on the next
// raise while its Telegram delivery has not been accepted (wave-5 audit: a failed delivery is not a delivery), and says "cleared"
// when `settle` no longer sees it.
import { appendFileSync, mkdirSync } from "node:fs";
import { readStateOr, stateDir, statePath, writeState } from "./state.mjs";

const REPEAT = { critical: 3600, warn: 6 * 3600, info: 24 * 3600 };
const RANK = { info: 0, warn: 1, critical: 2 };

/** Should a key fire now? Pure: `seen` is the key's last record. A higher level than the one recorded fires at once, and so does a key
 *  whose last message was not delivered. */
export function shouldFire(seen, level, nowSec) {
  if (!seen) return true;
  if (seen.level !== undefined && (RANK[level] ?? RANK.warn) > (RANK[seen.level] ?? RANK.warn)) return true;
  if (seen.undelivered) return true;
  return nowSec - seen.at >= (REPEAT[level] ?? REPEAT.warn);
}

/** Send to Telegram. Returns true when the message was accepted (HTTP 2xx), or when Telegram is not configured (nothing to deliver). */
export async function telegram(text, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return true;
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(8000),
    });
    return Boolean(r?.ok);
  } catch {
    return false; // the log and the file still hold it; the next raise of the key tries again
  }
}

/** `prefix` heads every Telegram message: "imdUSD v2 keeper" on mainnet (unchanged), the chain's ALERT_PREFIX elsewhere, so the ops chat
 *  tells a 4663 alert from a mainnet one. The log and alerts.jsonl live in the chain's own state dir already. `fetchImpl`: tests only. */
export function makeAlerts(log, prefix = "imdUSD v2 keeper", { fetchImpl = undefined, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const prefix0 = prefix;
  const emit = async (level, key, msg, retry = false) => {
    log(`ALERT ${level.toUpperCase()} ${key}: ${msg}${retry ? " (delivery retried)" : ""}`);
    if (!retry) {
      mkdirSync(stateDir(), { recursive: true });
      appendFileSync(statePath("alerts.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), level, key, msg })}\n`);
    }
    return telegram(`${prefix} ${level.toUpperCase()}\n${key}: ${msg}`, fetchImpl);
  };
  return {
    async raise(level, key, msg) {
      const s = readStateOr("alerts.json", {});
      const t = now();
      const seen = s[key]?.clearing ? undefined : s[key]; // a "cleared" still being delivered: the key fires anew
      if (!shouldFire(seen, level, t)) return;
      // A retry of an undelivered message at the same level keeps its first time: the repeat interval counts from the first raise.
      const retry = Boolean(seen?.undelivered) && (RANK[level] ?? 1) <= (RANK[seen.level] ?? 1) && t - seen.at < (REPEAT[level] ?? REPEAT.warn);
      const rec = { at: retry ? seen.at : t, level: retry ? seen.level : level };
      s[key] = rec;
      writeState("alerts.json", s);
      const delivered = await emit(level, key, msg, retry);
      if (!delivered) {
        const s2 = readStateOr("alerts.json", {});
        if (s2[key]) {
          s2[key].undelivered = true;
          s2[key].msg = String(msg).slice(0, 3500); // kept for a retry from settle: a key raised once is still delivered
          writeState("alerts.json", s2);
        }
      } else if (seen?.undelivered) {
        const s2 = readStateOr("alerts.json", {});
        if (s2[key]) {
          delete s2[key].undelivered;
          delete s2[key].msg;
          writeState("alerts.json", s2);
        }
      }
    },
    /** Clear every key starting with `prefix` that was not raised in this pass. `held`: a Set of keys, or a function key -> true for
     *  a key whose condition could not be read this pass (it stands: could-not-tell is not fine). */
    async settle(prefix, held) {
      const keep = typeof held === "function" ? held : (k) => held.has(k);
      // Re-read before each write: loops in other lanes may have raised keys while this one awaited (keeper.mjs runLanes).
      const put = (key, rec) => { const s = readStateOr("alerts.json", {}); if (rec) s[key] = rec; else delete s[key]; writeState("alerts.json", s); };
      for (const key of Object.keys(readStateOr("alerts.json", {}))) {
        if (!key.startsWith(prefix)) continue;
        const rec = readStateOr("alerts.json", {})[key];
        if (!rec) continue;
        // Internal review after wave 5, alert lifecycle:
        if (rec.clearing) { // a "cleared" whose delivery failed: try it again until it goes
          if (await telegram(`${prefix0} INFO\n${key}: cleared (was ${rec.level})`, fetchImpl)) put(key, null);
          continue;
        }
        if (keep(key)) { // standing: an undelivered message is tried again even if nothing raises the key again
          if (rec.undelivered && rec.msg && (await telegram(`${prefix0} ${String(rec.level).toUpperCase()}\n${key}: ${rec.msg}`, fetchImpl))) {
            const { undelivered, msg, ...rest } = rec;
            put(key, rest);
          }
          continue;
        }
        if (rec.undelivered) { // never delivered: no "cleared" for a message nobody saw
          put(key, null);
          log(`ALERT INFO ${key}: cleared (was ${rec.level}, never delivered)`);
          continue;
        }
        put(key, null);
        if (!(await emit("info", key, `cleared (was ${rec.level})`))) put(key, { clearing: true, level: rec.level, at: now() });
      }
    },
  };
}
