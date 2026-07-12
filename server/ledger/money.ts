import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function money(value: string | Decimal): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) throw new Error("Money amount must be finite and non-negative.");
  return decimal.toDecimalPlaces(2);
}

export function rate(value: string | Decimal): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.lte(0)) throw new Error("Rate must be finite and positive.");
  return decimal.toDecimalPlaces(12);
}

export function fixed(value: Decimal, places = 2): string {
  return value.toDecimalPlaces(places).toFixed(places);
}
