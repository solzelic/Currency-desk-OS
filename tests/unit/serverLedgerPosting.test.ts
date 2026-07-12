import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import type { AuthenticatedLedgerActor, PostExchangeRequest, ReceiptReadyTransaction, ReverseTransactionRequest } from "../../server/ledger/contracts";
import { LedgerApiError } from "../../server/ledger/errors";
import type { LedgerPostingStore, LockedPostingContext, PersistPost, PersistReversal, PersistedTransaction } from "../../server/ledger/service";
import { LedgerPostingService } from "../../server/ledger/service";

const actor: AuthenticatedLedgerActor = { tenantId: "tenant-1", legalEntityId: "le-1", branchId: "branch-1", workspaceId: "workspace-1", tillId: "till-1", userId: "teller-1", role: "teller", authorizedBranchIds: ["branch-1"] };
const request: PostExchangeRequest = { idempotencyKey: "post-1", customerId: "customer-1", from: "CAD", to: "USD", inputAmount: "1000.00", feeCad: "4.00", purpose: "Travel", sourceOfFunds: "Cash" };

class MemoryLedgerStore implements LedgerPostingStore {
  private gate = Promise.resolve();
  responses = new Map<string, ReceiptReadyTransaction | "processing">(); posts: PersistPost[] = []; reversed = false;
  context: LockedPostingContext = { actor: { ...actor, id: actor.userId, name: "Teller", authorizedBranchIds: ["branch-1"] }, customer: { id: "customer-1", name: "Verified Customer", risk: "Normal", idStatus: "verified" }, till: { CAD: new Decimal("25000"), USD: new Decimal("12000"), EUR: new Decimal("7000"), GBP: new Decimal("3500") }, unitsPerCad: { CAD: new Decimal(1), USD: new Decimal("0.731"), EUR: new Decimal("0.676"), GBP: new Decimal("0.581") }, nextSequence: 1 };
  async transaction<T>(work: (store: LedgerPostingStore) => Promise<T>): Promise<T> { const previous = this.gate; let release = () => {}; this.gate = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(this); } finally { release(); } }
  async getIdempotent(_: AuthenticatedLedgerActor, key: string) { return this.responses.get(key) ?? null; }
  async claimIdempotency(_: AuthenticatedLedgerActor, key: string) { if (this.responses.has(key)) return false; this.responses.set(key, "processing"); return true; }
  async lockPostingContext(_: AuthenticatedLedgerActor, customerId: string) { return customerId === this.context.customer.id ? this.context : null; }
  async persistPost(input: PersistPost) { this.posts.push(input); this.responses.set(input.request.idempotencyKey, input.response); }
  async lockReversibleTransaction(_: AuthenticatedLedgerActor, id: string): Promise<PersistedTransaction | null> { if (!this.posts[0] || this.posts[0].response.transactionId !== id) return null; if (this.reversed) throw new LedgerApiError("REVERSAL_ALREADY_EXISTS", "The transaction already has a reversal."); const p = this.posts[0]; return { ...p.response, registeredActor: this.context.actor, originalTillMovements: p.tillMovements }; }
  async persistReversal(input: PersistReversal) { this.reversed = true; const response = { ...input.original, status: "reversed" as const }; this.responses.set(input.request.idempotencyKey, response); return response; }
}

function service(store: MemoryLedgerStore) { let n = 0; return new LedgerPostingService(store, () => `id-${++n}`, () => new Date("2026-07-12T12:00:00.000Z")); }

describe("server ledger posting", () => {
  it("recalculates authoritative quote values and persists one balanced journal", async () => {
    const store = new MemoryLedgerStore(); const result = await service(store).post(actor, { ...request, inputAmount: "1000.009", feeCad: "4.004" });
    expect(result.outputAmount).toBe("724.43"); expect(result.feeCad).toBe("4.00"); expect(store.posts).toHaveLength(1);
    const journal = store.posts[0].journal; const debit = journal.filter((line) => line.side === "debit").reduce((sum, line) => sum.add(line.amountCad), new Decimal(0)); const credit = journal.filter((line) => line.side === "credit").reduce((sum, line) => sum.add(line.amountCad), new Decimal(0));
    expect(debit.eq(credit)).toBe(true);
  });
  it("returns the first receipt-ready response on an idempotent retry", async () => { const store = new MemoryLedgerStore(); const api = service(store); const first = await api.post(actor, request); const second = await api.post(actor, request); expect(second).toEqual(first); expect(store.posts).toHaveLength(1); });
  it("does not create duplicate posts during concurrent retries", async () => { const store = new MemoryLedgerStore(); const api = service(store); const results = await Promise.all([api.post(actor, request), api.post(actor, request)]); expect(store.posts).toHaveLength(1); expect(results[1]).toEqual(results[0]); });
  it("rejects a role without transaction:post", async () => { const store = new MemoryLedgerStore(); store.context.actor = { ...store.context.actor, role: "auditor" }; await expect(service(store).post({ ...actor, role: "auditor" }, request)).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" }); });
  it("requires reversal permission and a reason, then prevents a second reversal", async () => { const store = new MemoryLedgerStore(); const api = service(store); const posted = await api.post(actor, request); const reverse: ReverseTransactionRequest = { idempotencyKey: "reverse-1", reason: "Customer correction" }; await expect(api.reverse(actor, posted.transactionId, reverse)).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" }); const supervisor = { ...actor, userId: "supervisor-1", role: "supervisor" as const }; store.context.actor = { ...store.context.actor, id: supervisor.userId, role: supervisor.role }; const reversed = await api.reverse(supervisor, posted.transactionId, reverse); expect(reversed.status).toBe("reversed"); await expect(api.reverse(supervisor, posted.transactionId, { ...reverse, idempotencyKey: "reverse-2" })).rejects.toMatchObject({ code: "REVERSAL_ALREADY_EXISTS" }); });
});
