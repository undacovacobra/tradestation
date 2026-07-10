import { log } from "./logger.js";

// Read Telegram creds straight from the environment (config.js already loaded
// .env via dotenv). Reading env directly here keeps this module free of the
// config module's required-var checks, so browser tests can import it safely.
const token = () => process.env.TELEGRAM_BOT_TOKEN ?? "";
const chatId = () => process.env.TELEGRAM_CHAT_ID ?? "";

/**
 * Phone notifications via Telegram. Free, no phone-number costs, works
 * anywhere. Disabled unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set in
 * .env. Fire-and-forget: a notification failure must never affect trading, so
 * errors are only logged. Identical messages are deduped for 60s so a repeating
 * problem doesn't buzz the phone nonstop.
 */
const recentlySent = new Map<string, number>();
const DEDUPE_MS = 60_000;

/**
 * "You're needed" — a problem the bot could NOT fix by itself and that a human
 * should look at (trade failed, popup stuck, needs a login). These are the only
 * things that should interrupt your day.
 */
export function notifyActionNeeded(text: string): void {
  notifyPhone(`🔴 NEEDS YOU — ${text}`);
}

/** Good news worth a single happy ping (a win, a passed account). */
export function notifyGoodNews(text: string): void {
  notifyPhone(text);
}

export function notifyPhone(text: string): void {
  const botToken = token();
  const chat = chatId();
  if (!botToken || !chat) return;
  const now = Date.now();
  const last = recentlySent.get(text) ?? 0;
  if (now - last < DEDUPE_MS) return;
  recentlySent.set(text, now);
  if (recentlySent.size > 200) {
    for (const [key, at] of recentlySent) if (now - at > DEDUPE_MS * 5) recentlySent.delete(key);
  }
  fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) log.warn(`Telegram notification failed: HTTP ${res.status}`);
    })
    .catch((err) => log.warn(`Telegram notification failed: ${(err as Error).message}`));
}
