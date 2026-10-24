/* No append-only credit ledger exists here. Do not invent one. Do not settle. */
export function reserveIdvCredit(referenceId: string): "no_ledger" {
  return referenceId ? "no_ledger" : "no_ledger";
}
