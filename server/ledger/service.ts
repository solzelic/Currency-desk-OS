import Decimal from "decimal.js";
import { canPostTransactions, canReverseTransactions } from "../../src/security/authorization";
import type { StaffUser } from "../../src/domain/types";
import type { AuthenticatedLedgerActor, LedgerCurrency, PostExchangeRequest, ReceiptReadyTransaction, ReverseTransactionRequest } from "./contracts";
import { LedgerApiError } from "./errors";
import { fixed, money, rate } from "./money";

export interface LedgerCustomer { id: string; name: string; risk: "Low" | "Normal" | "Medium" | "High"; idStatus: string; }
export interface LockedPostingContext {
  actor: StaffUser;
  customer: LedgerCustomer;
  till: Record<LedgerCurrency, Decimal>;
  unitsPerCad: Record<LedgerCurrency, Decimal>;
  nextSequence: number;
}

export interface LedgerPostingStore {
  transaction<T>(work: (store: LedgerPostingStore) => Promise<T>): Promise<T>;
  getIdempotent(scope: AuthenticatedLedgerActor, key: string): Promise<ReceiptReadyTransaction | null | "processing">;
  claimIdempotency(scope: AuthenticatedLedgerActor, key: string): Promise<boolean>;
  lockPostingContext(scope: AuthenticatedLedgerActor, customerId: string): Promise<LockedPostingContext | null>;
  persistPost(input: PersistPost): Promise<void>;
  lockReversibleTransaction(scope: AuthenticatedLedgerActor, transactionId: string): Promise<PersistedTransaction | null>;
  persistReversal(input: PersistReversal): Promise<ReceiptReadyTransaction>;
}

export interface PersistPost {
  actor: AuthenticatedLedgerActor;
  request: PostExchangeRequest;
  response: ReceiptReadyTransaction;
  customer: LedgerCustomer;
  inputCad: Decimal;
  outputCad: Decimal;
  feeCad: Decimal;
  tillMovements: Array<{ currency: LedgerCurrency; direction: "in" | "out"; amount: Decimal }>;
  journal: Array<{ account: string; side: "debit" | "credit"; amountCad: Decimal }>;
}

export interface PersistedTransaction extends ReceiptReadyTransaction { originalTillMovements: PersistPost["tillMovements"]; registeredActor: StaffUser; }
export interface PersistReversal { actor: AuthenticatedLedgerActor; request: ReverseTransactionRequest; original: PersistedTransaction; reversalId: string; postedAt: string; }

function asStaffUser(actor: AuthenticatedLedgerActor): StaffUser {
  return { tenantId: actor.tenantId, legalEntityId: actor.legalEntityId, branchId: actor.branchId, workspaceId: actor.workspaceId, id: actor.userId, name: actor.userId, role: actor.role, authorizedBranchIds: [...actor.authorizedBranchIds] };
}

function assertScopeAndPermission(actor: AuthenticatedLedgerActor, registered: StaffUser, permission: "post" | "reverse"): void {
  if (registered.id !== actor.userId || registered.role !== actor.role || registered.tenantId !== actor.tenantId || registered.legalEntityId !== actor.legalEntityId || registered.branchId !== actor.branchId || registered.workspaceId !== actor.workspaceId) {
    throw new LedgerApiError("SCOPE_DENIED", "Authenticated user is outside the requested workspace.");
  }
  const decision = permission === "post" ? canPostTransactions(registered, actor) : canReverseTransactions(registered, actor);
  if (!decision) throw new LedgerApiError("AUTHORIZATION_DENIED", `Missing transaction:${permission} permission.`);
}

function quote(request: PostExchangeRequest, unitsPerCad: Record<LedgerCurrency, Decimal>) {
  if (request.from === request.to) throw new LedgerApiError("INVALID_REQUEST", "Source and destination currencies must differ.");
  const input = money(request.inputAmount);
  const fee = money(request.feeCad);
  if (input.lte(0)) throw new LedgerApiError("INVALID_REQUEST", "Input amount must be greater than zero.");
  const outputRate = rate(unitsPerCad[request.to].div(unitsPerCad[request.from]));
  const inputCad = input.div(unitsPerCad[request.from]).toDecimalPlaces(2);
  const grossOutput = input.mul(outputRate);
  const output = grossOutput.mul("0.991").toDecimalPlaces(2);
  const outputCad = output.div(unitsPerCad[request.to]).toDecimalPlaces(2);
  const spreadCad = inputCad.sub(outputCad).toDecimalPlaces(2);
  return { input, fee, outputRate, inputCad, output, outputCad, spreadCad };
}

function receiptLines(response: Omit<ReceiptReadyTransaction, "receipt">, customer: LedgerCustomer, actor: AuthenticatedLedgerActor): string[] {
  return ["CurrencyDesk OS", `Receipt ${response.transactionRef}`, `Customer: ${customer.name}`, `Teller: ${actor.userId}`, `Paid: ${response.inputAmount} ${response.from}`, `Received: ${response.outputAmount} ${response.to}`, `Rate: 1 ${response.from} = ${response.rate} ${response.to}`, `Fee: CAD ${response.feeCad}`];
}

export class LedgerPostingService {
  constructor(private readonly store: LedgerPostingStore, private readonly ids: () => string = () => crypto.randomUUID(), private readonly now: () => Date = () => new Date()) {}

  async post(actor: AuthenticatedLedgerActor, request: PostExchangeRequest): Promise<ReceiptReadyTransaction> {
    if (!request.idempotencyKey || request.idempotencyKey.length > 200) throw new LedgerApiError("INVALID_REQUEST", "A valid idempotency key is required.");
    return this.store.transaction(async (store) => {
      const idempotencyKey = `post:${request.idempotencyKey}`;
      const prior = await store.getIdempotent(actor, idempotencyKey);
      if (prior && prior !== "processing") return prior;
      if (prior === "processing" || !(await store.claimIdempotency(actor, idempotencyKey))) throw new LedgerApiError("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress.");
      const context = await store.lockPostingContext(actor, request.customerId);
      if (!context) throw new LedgerApiError("CUSTOMER_NOT_FOUND", "Customer was not found in the authenticated workspace.");
      assertScopeAndPermission(actor, context.actor, "post");
      const q = quote(request, context.unitsPerCad);
      if (q.inputCad.gte(3000) && context.customer.idStatus !== "verified") throw new LedgerApiError("COMPLIANCE_BLOCKED", "Verified identity is required for this transaction.");
      if (q.inputCad.gte(10000) && (!request.purpose.trim() || !request.sourceOfFunds.trim())) throw new LedgerApiError("COMPLIANCE_BLOCKED", "Purpose and source of funds are required for reportable transactions.");
      if (context.till[request.to].lt(q.output)) throw new LedgerApiError("INSUFFICIENT_TILL_LIQUIDITY", "Till liquidity is insufficient for the requested payout.");
      const postedAt = this.now().toISOString();
      const transactionId = `tx_${this.ids()}`;
      const transactionRef = `CD-${postedAt.slice(2, 10).replace(/-/g, "")}-${String(context.nextSequence).padStart(6, "0")}`;
      const base = { transactionId, transactionRef, postedAt, status: "posted" as const, customerId: request.customerId, from: request.from, to: request.to, inputAmount: fixed(q.input), outputAmount: fixed(q.output), rate: fixed(q.outputRate, 12), feeCad: fixed(q.fee), spreadCad: fixed(q.spreadCad) };
      const response: ReceiptReadyTransaction = { ...base, receipt: { receiptId: `rcpt_${transactionId}`, lines: receiptLines(base, context.customer, actor) } };
      const tillMovements: PersistPost["tillMovements"] = [{ currency: request.from, direction: "in", amount: q.input }, { currency: request.to, direction: "out", amount: q.output }];
      if (!q.fee.isZero()) tillMovements.push({ currency: "CAD", direction: "in", amount: q.fee });
      const journal = [
        { account: `till:${request.from}`, side: "debit" as const, amountCad: q.inputCad.add(q.fee) },
        { account: `till:${request.to}`, side: "credit" as const, amountCad: q.outputCad },
        { account: "revenue:fx_spread", side: "credit" as const, amountCad: q.spreadCad },
        { account: "revenue:fee", side: "credit" as const, amountCad: q.fee }
      ];
      const debits = journal.filter((line) => line.side === "debit").reduce((sum, line) => sum.add(line.amountCad), new Decimal(0));
      const credits = journal.filter((line) => line.side === "credit").reduce((sum, line) => sum.add(line.amountCad), new Decimal(0));
      if (!debits.eq(credits)) throw new Error("Unbalanced journal rejected.");
      await store.persistPost({ actor, request: { ...request, idempotencyKey }, response, customer: context.customer, inputCad: q.inputCad, outputCad: q.outputCad, feeCad: q.fee, tillMovements, journal });
      return response;
    });
  }

  async reverse(actor: AuthenticatedLedgerActor, transactionId: string, request: ReverseTransactionRequest): Promise<ReceiptReadyTransaction> {
    if (!request.reason.trim() || !request.idempotencyKey) throw new LedgerApiError("INVALID_REQUEST", "A reversal reason and idempotency key are required.");
    return this.store.transaction(async (store) => {
      const idempotencyKey = `reverse:${request.idempotencyKey}`;
      const prior = await store.getIdempotent(actor, idempotencyKey);
      if (prior && prior !== "processing") return prior;
      const original = await store.lockReversibleTransaction(actor, transactionId);
      if (!original) throw new LedgerApiError("TRANSACTION_NOT_FOUND", "Posted transaction was not found in the authenticated workspace.");
      assertScopeAndPermission(actor, original.registeredActor, "reverse");
      if (prior === "processing" || !(await store.claimIdempotency(actor, idempotencyKey))) throw new LedgerApiError("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress.");
      return store.persistReversal({ actor, request: { ...request, idempotencyKey }, original, reversalId: `rv_${this.ids()}`, postedAt: this.now().toISOString() });
    });
  }
}
