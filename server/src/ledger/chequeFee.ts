/* The screen's fee, loaded from the same file the desk runs.
   A second copy here would be the next 20.00 / 20.01 disagreement. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

type FeeFn = (face: unknown, feePct: unknown, feeMin: unknown) => string | null;

const sandbox = createContext({}) as { chequeScheduleFee?: FeeFn };
const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../os-src/cheque-fee.js"), "utf8");
runInContext(source, sandbox);

export function chequeScheduleFee(face: unknown, feePct: unknown, feeMin: unknown): string | null {
  const fn = sandbox.chequeScheduleFee;
  if (typeof fn !== "function") throw new Error("cheque fee helper missing");
  const out = fn(face, feePct, feeMin);
  return out == null ? null : String(out);
}
