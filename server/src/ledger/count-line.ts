/* A denomination line on the till print.

   Face is a whole number of minor units (a five-cent coin is 5, a
   hundred-dollar bill is 10000). Quantity is a whole number of pieces.
   The line total is their product, still in minor units. A fraction is
   refused. Nothing here rounds, and nothing here uses a float. */

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
