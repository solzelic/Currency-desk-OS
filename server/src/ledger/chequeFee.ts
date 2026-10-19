/* The screen's fee, loaded from the same file the desk runs.
   A second copy here would be the next 20.00 / 20.01 disagreement. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

type FeeFn = (face: unknown, feePct: unknown, feeMin: unknown) => string | null;
type TextFn = (value: unknown) => string | null;
type ShownFn = (value: unknown) => string | null;
type ProblemFn = (value: unknown, kind: string) => string | null;

type FeeBox = {
  chequeScheduleFee?: FeeFn;
  feePctText?: TextFn;
  feePctShown?: ShownFn;
  feeFigureProblem?: ProblemFn;
  moneyShown?: ShownFn;
  feePctCommit?: ShownFn;
};

const sandbox = createContext({}) as { CDOS_CHEQUE_FEE?: FeeBox };
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../os-src/cheque-fee.js"), "utf8");
runInContext(source, sandbox);

function box(): FeeBox {
  const found = sandbox.CDOS_CHEQUE_FEE;
  if (!found || typeof found.chequeScheduleFee !== "function") throw new Error("cheque fee helper missing");
  return found;
}

export function chequeScheduleFee(face: unknown, feePct: unknown, feeMin: unknown): string | null {
  const out = box().chequeScheduleFee!(face, feePct, feeMin);
  return out == null ? null : String(out);
}

export function feePctText(value: unknown): string | null {
  const fn = box().feePctText;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(value);
  return out == null ? null : String(out);
}

export function feeFigureProblem(value: unknown, kind: "percent" | "money"): "places" | "unread" | null {
  const fn = box().feeFigureProblem;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(value, kind);
  if (out == null) return null;
  if (out !== "places" && out !== "unread") throw new Error("cheque fee helper missing");
  return out;
}

export function moneyShown(value: unknown): string | null {
  const fn = box().moneyShown;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(value);
  return out == null ? null : String(out);
}

export function feePctCommit(value: unknown): string | null {
  const fn = box().feePctCommit;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(value);
  return out == null ? null : String(out);
}

export function feePctShown(value: unknown): string | null {
  const fn = box().feePctShown;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(value);
  return out == null ? null : String(out);
}
