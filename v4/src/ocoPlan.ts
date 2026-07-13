export interface InstrumentProfile {
  tickSize: number;
  pointValue: number;
}

export interface OcoPricePlan extends InstrumentProfile {
  symbol: string;
  side: "long" | "short";
  takeProfitPrice: number;
  stopLossPrice: number;
}

const PROFILES: Record<string, InstrumentProfile> = {
  MNQ: { tickSize: 0.25, pointValue: 2 },
  NQ: { tickSize: 0.25, pointValue: 20 },
  MES: { tickSize: 0.25, pointValue: 5 },
  ES: { tickSize: 0.25, pointValue: 50 },
};

function normalizePrice(value: number, tickSize: number): number {
  const decimals = Math.max(0, (String(tickSize).split(".")[1] ?? "").length);
  return Number(value.toFixed(decimals));
}

export function planOcoPrices(
  symbolInput: string,
  action: "buy" | "sell",
  entryPrice: number,
  targetDollars: number,
  stopDollars: number,
): OcoPricePlan {
  const rawSymbol = symbolInput.trim().toUpperCase();
  const symbol = Object.keys(PROFILES)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => rawSymbol === candidate || rawSymbol.startsWith(candidate)) ?? rawSymbol;
  const profile = PROFILES[symbol];
  if (!profile) throw new Error(`Unsupported Fast Entry symbol ${symbol || "(blank)"}.`);
  if (!(entryPrice > 0) || !(targetDollars > 0) || !(stopDollars > 0)) throw new Error("Entry price, take profit, and stop loss must be positive.");
  const targetTicks = Math.ceil((targetDollars / profile.pointValue) / profile.tickSize - 1e-9);
  const stopTicks = Math.ceil((stopDollars / profile.pointValue) / profile.tickSize - 1e-9);
  const targetDistance = targetTicks * profile.tickSize;
  const stopDistance = stopTicks * profile.tickSize;
  const side = action === "buy" ? "long" : "short";
  return {
    symbol,
    ...profile,
    side,
    takeProfitPrice: normalizePrice(entryPrice + (side === "long" ? targetDistance : -targetDistance), profile.tickSize),
    stopLossPrice: normalizePrice(entryPrice + (side === "long" ? -stopDistance : stopDistance), profile.tickSize),
  };
}
