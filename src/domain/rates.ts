import type { CurrencyCode, RateQuote } from "./types";

const perCad: Record<CurrencyCode, number> = {
  CAD: 1,
  USD: 0.731,
  EUR: 0.676,
  GBP: 0.581
};

export function crossRate(from: CurrencyCode, to: CurrencyCode): number {
  return round(perCad[to] / perCad[from], 4);
}

export function quoteExchange(from: CurrencyCode, to: CurrencyCode, inputAmount: number, feeCad: number): RateQuote {
  const rate = crossRate(from, to);
  const midOutput = inputAmount * rate;
  const spreadCad = round(inputAmountCad(from, inputAmount) * 0.009, 2);
  const outputAmount = round(midOutput * 0.991, 2);

  return {
    from,
    to,
    inputAmount,
    rate,
    outputAmount,
    feeCad,
    spreadCad,
    totalProfitCad: round(spreadCad + feeCad, 2)
  };
}

export function inputAmountCad(currency: CurrencyCode, amount: number): number {
  return currency === "CAD" ? amount : round(amount / crossRate("CAD", currency), 2);
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((Number.isFinite(value) ? value : 0) * factor) / factor;
}

export function money(value: number, currency: CurrencyCode = "CAD"): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency
  }).format(value || 0);
}
