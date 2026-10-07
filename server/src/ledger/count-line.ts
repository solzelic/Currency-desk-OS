/* A denomination line on the till print.

   Face is a whole number of minor units (a five-cent coin is 5, a
   hundred-dollar bill is 10000). Quantity is a whole number of pieces.
   The line total is their product, still in minor units. A fraction is
   refused. Nothing here rounds, and nothing here uses a float.

   The sheet also states, per currency, what was counted, what the
   ledger expected, and the difference. Expected is the ledger's own
   balance string. The difference is Decimal subtraction. A missing
   expected or a missing count stays absent. */
import Decimal from "decimal.js";

export type CountLineInput = {
  currency: string;
  faceMinor: number;
  quantity: number;
};

export type CountLineTotal = CountLineInput & {
  minor: number;
};

export function countLineMinor(faceMinor: number, quantity: number): number {
  if (!Number.isInteger(faceMinor) || faceMinor < 0) {
    throw new Error("A denomination face is a whole number of minor units.");
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("A denomination quantity is a whole number of pieces.");
  }
  const minor = faceMinor * quantity;
  if (!Number.isSafeInteger(minor)) {
    throw new Error("That count line is too large to total.");
  }
  return minor;
}

export function priceCountLines(lines: CountLineInput[]): CountLineTotal[] {
  return lines.map((line) => ({
    currency: line.currency,
    faceMinor: line.faceMinor,
    quantity: line.quantity,
    minor: countLineMinor(line.faceMinor, line.quantity),
  }));
}

/* 15 minor units is "0.15". The split is on digits. */
export function minorToAmount(minor: number): string {
  if (!Number.isInteger(minor)) {
    throw new Error("A count total is a whole number of minor units.");
  }
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(3, "0");
  return (negative ? "-" : "") + digits.slice(0, -2) + "." + digits.slice(-2);
}

/* "200.00" is 20000 minor units. A fraction of a minor unit is refused. */
export function amountToMinor(amount: string): number {
  const parsed = new Decimal(amount);
  const minor = parsed.mul(100);
  if (!minor.isFinite() || !minor.isInteger() || minor.isNegative()) {
    throw new Error("A typed total is a whole number of minor units.");
  }
  const asNumber = minor.toNumber();
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error("That count is too large to total.");
  }
  return asNumber;
}

export type TypedCount = {
  currency: string;
  amount: string;
};

export type CurrencySheet = {
  currency: string;
  counted: string | null;
  expected: string | null;
  variance: string | null;
};

export type CountSheet = {
  lines: CountLineTotal[];
  currencies: CurrencySheet[];
};

export function buildCountSheet(input: {
  lines: CountLineInput[];
  typed: TypedCount[];
  expected: Record<string, string>;
}): CountSheet {
  const lines = priceCountLines(input.lines);
  const countedMinor = new Map<string, number>();
  for (const line of lines) {
    const next = (countedMinor.get(line.currency) ?? 0) + line.minor;
    if (!Number.isSafeInteger(next)) {
      throw new Error("That count is too large to total.");
    }
    countedMinor.set(line.currency, next);
  }
  const typedCurrencies = new Set<string>();
  for (const row of input.typed) {
    if (countedMinor.has(row.currency)) {
      throw new Error("A currency is counted by denomination or as one total, not both.");
    }
    if (typedCurrencies.has(row.currency)) {
      throw new Error("A currency is listed twice.");
    }
    typedCurrencies.add(row.currency);
    countedMinor.set(row.currency, amountToMinor(row.amount));
  }
  const currencies = [...new Set([...Object.keys(input.expected), ...countedMinor.keys()])].sort();
  return {
    lines,
    currencies: currencies.map((currency) => {
      const counted = countedMinor.has(currency) ? minorToAmount(countedMinor.get(currency)!) : null;
      const expected = Object.prototype.hasOwnProperty.call(input.expected, currency)
        ? input.expected[currency]!
        : null;
      const variance = counted == null || expected == null
        ? null
        : new Decimal(counted).minus(expected).toFixed(2);
      return { currency, counted, expected, variance };
    }),
  };
}
