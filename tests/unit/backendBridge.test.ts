import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type BackendBridge = {
  customerPayload(name: string, record: Record<string, unknown>): Record<string, unknown>;
  syncCustomer(name: string, record: Record<string, unknown>): Promise<Record<string, unknown>>;
  createQuote(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  transactionToRow(transaction: Record<string, unknown>, customerName: string): Record<string, unknown>;
  mergeRows(existing: Record<string, unknown>[], serverRows: Record<string, unknown>[]): Record<string, unknown>[];
};

function loadBridge(fetchMock: ReturnType<typeof vi.fn>) {
  const windowObject: { CDOS?: { Backend: BackendBridge } } = {};
  const source = readFileSync(resolve(process.cwd(), "os-src/cdos-backend.js"), "utf8");
  new Function("window", "fetch", source)(windowObject, fetchMock);
  return windowObject.CDOS!.Backend;
}

describe("browser backend bridge", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("normalizes a local customer and synchronizes it idempotently", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ customerId: "cust_1", externalRef: "os:alex-smith" }),
    });
    const backend = loadBridge(fetchMock);

    await backend.syncCustomer("Alex Smith", {
      risk: "Medium",
      idType: "Passport",
      idNum: "P1",
      idExpiry: "2099-01-01",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/ledger/customers", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        externalRef: "os:alex-smith",
        name: "Alex Smith",
        risk: "enhanced",
        idStatus: "verified",
      }),
    }));
  });

  it("surfaces a safe error when the server rejects a quote", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ code: "UNSUPPORTED_CURRENCY_PAIR" }),
    });
    const backend = loadBridge(fetchMock);

    await expect(backend.createQuote({ from: "CAD", to: "JPY" })).rejects.toMatchObject({
      code: "UNSUPPORTED_CURRENCY_PAIR",
      status: 422,
      message: "Server posting currently supports CAD exchanges with USD, EUR, or GBP.",
    });
  });

  it("maps authoritative transactions into ledger rows without duplicating them", () => {
    const backend = loadBridge(vi.fn());
    const row = backend.transactionToRow({
      transactionId: "tx_1",
      transactionRef: "CD-260728-000001",
      quoteId: "qt_1",
      customerId: "cust_1",
      actorId: "user_1",
      from: "CAD",
      to: "USD",
      inputAmount: "100.00",
      outputAmount: "72.00",
      rate: "0.720000000000",
      marketMid: "0.730000000000",
      feeCad: "2.00",
      spreadCad: "1.00",
      purpose: "Travel",
      sourceOfFunds: "Savings",
      postedAt: "2026-07-28T14:05:00.000Z",
      reversal: null,
    }, "Alex Smith");

    expect(row).toMatchObject({
      id: "srv_tx_1",
      serverTransactionId: "tx_1",
      serverQuoteId: "qt_1",
      customer: "Alex Smith",
      status: "posted",
      inAmt: 100,
      outAmt: 72,
      capture: { purpose: "Travel", source: "Savings" },
    });
    expect(backend.mergeRows([
      { id: "old", serverTransactionId: "tx_1" },
      { id: "local" },
    ], [row])).toEqual([row, { id: "local" }]);
  });
});
