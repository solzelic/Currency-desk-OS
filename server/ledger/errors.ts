import type { LedgerFailureCode } from "./contracts";

export class LedgerApiError extends Error {
  constructor(readonly code: LedgerFailureCode, message: string) {
    super(message);
  }
}
