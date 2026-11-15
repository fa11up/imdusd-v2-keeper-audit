// Alerts: always the log and state/alerts.jsonl; Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set. Each key fires once,
// again after its repeat interval while it holds, and says "cleared" when `clearMissing` no longer sees it.
import { appendFileSync, mkdirSync } from "node:fs";
import { readState, stateDir, statePath, writeState } from "./state.mjs";

const REPEAT = { critical: 3600, warn: 6 * 3600, info: 24 * 3600 };

/** Should a key fire now? Pure: `seen` is the key's last record. */
export function shouldFire(seen, level, nowSec) {
  if (!seen) return true;
  return nowSec - seen.at >= (REPEAT[level] ?? REPEAT.warn);
}

async function telegram(text, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* the log and the file still hold it */ }
}

export function makeAlerts(log) {
  const emit = async (level, key, msg) => {
    log(`ALERT ${level.toUpperCase()} ${key}: ${msg}`);
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(statePath("alerts.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), level, key, msg })}\n`);
    await telegram(`imdUSD v2 keeper ${level.toUpperCase()}\n${key}: ${msg}`);
  };
  return {
    async raise(level, key, msg) {
      const s = readState("alerts.json", {});
      const now = Math.floor(Date.now() / 1000);
      if (!shouldFire(s[key], level, now)) return;
      s[key] = { at: now, level };
      writeState("alerts.json", s);
      await emit(level, key, msg);
    },
    /** Clear every key starting with `prefix` that was not raised in this pass (`held`). */
    async settle(prefix, held) {
      const s = readState("alerts.json", {});
      for (const key of Object.keys(s)) {
        if (!key.startsWith(prefix) || held.has(key)) continue;
        const { level } = s[key];
        delete s[key];
        writeState("alerts.json", s);
        await emit("info", key, `cleared (was ${level})`);
      }
    },
  };
}
