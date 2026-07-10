import "dotenv/config";

/**
 * Fire sample alerts at a RUNNING local server to verify the webhook wiring.
 * Safe to use in practice mode. Usage:
 *   npm run testhook              -> buy + close on the evals webhook
 *   npm run testhook -- funded    -> buy + close on the funded webhook
 */
const group = process.argv[2] === "funded" ? "funded" : "evals";
const port = Number(process.env.PORT ?? 3300);
const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error("Set WEBHOOK_SECRET in v2/.env first (copy .env.example).");
  process.exit(1);
}
const url = `http://localhost:${port}/webhook/${group}`;

async function send(payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`${payload.action} -> HTTP ${res.status}:`, await res.text());
}

// Mimics the single TradingView alert: an opening order (position -> long)
// followed by the closing order (position -> flat).
console.log(`Sending a test OPEN then CLOSE (single-alert style) to ${url} …`);
await send({ secret, action: "buy", symbol: "MNQ1!", quantity: 1, marketPosition: "long" });
await new Promise((r) => setTimeout(r, 1500));
await send({ secret, action: "sell", symbol: "MNQ1!", marketPosition: "flat" });
console.log("Done — check the dashboard Activity feed.");
