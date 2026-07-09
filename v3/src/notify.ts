import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Phone notifications via Telegram. Free, no phone-number costs, works
 * anywhere. Disabled unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set in
 * .env. Fire-and-forget: a notification failure must never affect trading, so
 * errors are only logged. Identical messages are deduped for 60s so a repeating
 * problem doesn't buzz the phone nonstop.
 */
const recentlySent = new Map<string, number>();
const DEDUPE_MS = 60_000;

export function notifyPhone(text: string): void {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const now = Date.now();
  const last = recentlySent.get(text) ?? 0;
  if (now - last < DEDUPE_MS) return;
  recentlySent.set(text, now);
  if (recentlySent.size > 200) {
    for (const [key, at] of recentlySent) if (now - at > DEDUPE_MS * 5) recentlySent.delete(key);
  }
  fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) log.warn(`Telegram notification failed: HTTP ${res.status}`);
    })
    .catch((err) => log.warn(`Telegram notification failed: ${(err as Error).message}`));
}
