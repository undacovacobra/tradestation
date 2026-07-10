import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Args = Record<string, string | boolean>;
function parseArgs(values: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!value.startsWith("--")) continue;
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (!rawKey) continue;
    if (inline != null) args[rawKey] = inline;
    else if (values[i + 1] && !values[i + 1]!.startsWith("--")) args[rawKey] = values[++i]!;
    else args[rawKey] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const rl = createInterface({ input, output });
async function value(name: string, prompt: string, fallback?: string): Promise<string> {
  const supplied = args[name];
  if (typeof supplied === "string") return supplied;
  const answer = (await rl.question(`${prompt}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer || fallback || "";
}

try {
  const baseUrl = (await value("url", "V4 URL", "http://localhost:3500")).replace(/\/$/, "");
  const pool = await value("pool", "Pool id", "eval-primary");
  const secret = await value("secret", "Webhook secret");
  const action = await value("action", "Action (buy/sell/close)", "buy");
  const symbol = await value("symbol", "Symbol", "MNQ");
  const quantityText = await value("quantity", "Quantity", "1");
  const live = args.live === true;
  if (live) {
    const confirm = await rl.question("LIVE was requested. Type SEND LIVE to allow broker execution: ");
    if (confirm.trim() !== "SEND LIVE") throw new Error("Live send cancelled");
  }
  const payload = {
    secret,
    signalId: `manual-${Date.now()}`,
    action,
    symbol,
    quantity: Number(quantityText),
    marketPosition: action === "close" ? "flat" : action === "buy" ? "long" : "short",
    test: !live,
  };
  const response = await fetch(`${baseUrl}/webhook/${encodeURIComponent(pool)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  console.log(`\nHTTP ${response.status}`);
  console.log(text);
  if (!response.ok) process.exitCode = 1;
} finally {
  rl.close();
}
