/* Real HTTP/session/capability/audit integration on a fresh PGlite database.
   Only ledger principal mirroring and posting are mocked: this suite proves
   the refusal reaches the app audit trail without calling the money service.
   transfers-off.postgres.test.ts separately checks actual financial writes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, markTestShop, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { registerLedgerRoutes } from "../src/ledger/routes.js";
import { ObligationService } from "../src/ledger/obligations.js";
import { LedgerError } from "../src/ledger/service.js";
import * as transferGate from "../src/ledger/transfers-gate.js";
import * as auditWriter from "../src/audit.js";

vi.mock("../src/ledger/principal.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ledger/principal.js")>(),
  ensureLedgerPrincipal: vi.fn().mockResolvedValue(undefined),
}));

const ACTION = "transfer.refused_real_shop";
const route = (direction: "send" | "receive") => `/api/ledger/remittances/${direction}`;
const payload = (direction: "send" | "receive", key = "refusal-key") => ({
  idempotencyKey: key, customerId: "private-customer", reference: "private-reference",
  feeAmount: "5.00", payoutAmount: "70.00", corridor: "US", partner: "Private Partner",
  beneficiaryName: "Private Beneficiary", beneficiaryAddress: "Private address",
  purpose: "Private purpose", sourceOfFunds: "Private source",
  ...(direction === "send" ? { principalAmount: "100.00", payoutCurrency: "USD" }
    : { sentCurrency: "USD", sentAmount: "100.00" }),
});
let handle: DbHandle, app: FastifyInstance;
let cookies: Record<string, string>;
const events = () => handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, ACTION));
const request = (direction: "send" | "receive", key = "refusal-key") =>
  app.inject({ method: "POST", url: route(direction), cookies, payload: payload(direction, key) });

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("LEDGER_DATABASE_URL", "");
  vi.stubEnv("PGLITE_MEMORY", "1");
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  // No connection is opened: both operations that use the ledger pool are mocked.
  registerLedgerRoutes(app, handle.db, "postgres://unused/never-connected");
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "r.haddad", password: DEMO.password } });
  expect(login.statusCode, login.body).toBe(200);
  const session = login.cookies.find(c => c.name === "cdos_session");
  if (!session) throw new Error("No session cookie");
  cookies = { cdos_session: session.value };
});
afterAll(async () => { await app.close(); await handle.close(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await markTestShop(handle.db, DEMO.tenantId, false);
  await handle.db.update(schema.staffUsers).set({ role: "branch_manager" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
  await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, ACTION));
  vi.spyOn(ObligationService.prototype, "remittanceSend").mockImplementation(async () => { throw new Error("Posting must not run"); });
  vi.spyOn(ObligationService.prototype, "remittanceReceive").mockImplementation(async () => { throw new Error("Posting must not run"); });
});
afterEach(() => vi.restoreAllMocks());

describe("transfer refusal audit", () => {
  it.each(["send", "receive"] as const)("audits a refused %s with authenticated scope and bounded detail", async direction => {
    const res = await request(direction, "  refusal-key  ");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe("TRANSFERS_NOT_AVAILABLE");
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
      actorId: `${DEMO.tenantId}:r.haddad`, action: ACTION,
    });
    expect(rows[0]?.detail).toEqual({ route: route(direction), idempotencyKey: "refusal-key" });
    expect(rows[0]?.id).toBeTruthy();
    expect(rows[0]?.at).toBeInstanceOf(Date);
    expect(ObligationService.prototype.remittanceSend).not.toHaveBeenCalled();
    expect(ObligationService.prototype.remittanceReceive).not.toHaveBeenCalled();
  });

  it.each(["teller", "supervisor", "compliance_officer", "branch_manager", "administrator", "auditor"] as const)("audits refusals for %s without a role exemption", async role => {
    await handle.db.update(schema.staffUsers).set({ role }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
    const res = await request("send");
    expect(res.statusCode, res.body).toBe(422);
    expect(await events()).toHaveLength(1);
    expect(ObligationService.prototype.remittanceSend).not.toHaveBeenCalled();
  });

  it("audits each refused retry without treating it as a financial replay", async () => {
    expect((await request("send")).statusCode).toBe(422);
    expect((await request("send")).statusCode).toBe(422);
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
    expect(rows.map(row => row.detail)).toEqual(Array(2).fill({ route: route("send"), idempotencyKey: "refusal-key" }));
    expect(ObligationService.prototype.remittanceSend).not.toHaveBeenCalled();
  });

  it.each(["send", "receive"] as const)("does not post a %s when the refusal audit cannot be stored", async direction => {
    const writer = vi.spyOn(auditWriter, "audit").mockRejectedValueOnce(new Error("audit unavailable"));
    const res = await request(direction);
    expect(writer).toHaveBeenCalledOnce();
    expect(res.statusCode, res.body).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");
    expect(await events()).toHaveLength(0);
    expect(ObligationService.prototype.remittanceSend).not.toHaveBeenCalled();
    expect(ObligationService.prototype.remittanceReceive).not.toHaveBeenCalled();
  });

  it("does not manufacture a real-shop refusal event before authentication or validation", async () => {
    const unauthenticated = await app.inject({ method: "POST", url: route("send"), payload: payload("send") });
    expect(unauthenticated.statusCode).toBe(401);
    const invalid = await app.inject({ method: "POST", url: route("send"), cookies, payload: { ...payload("send"), tenantId: "forged-tenant", actorId: "forged-actor" } });
    expect(invalid.statusCode).toBe(400);
    expect(await events()).toHaveLength(0);
  });

  it("does not call the refusal writer for test-shop posting errors", async () => {
    await markTestShop(handle.db);
    const writer = vi.spyOn(auditWriter, "audit");
    // A failure in the allowed posting path is not a capability refusal.
    vi.mocked(ObligationService.prototype.remittanceSend).mockRejectedValueOnce(new LedgerError("TRANSFERS_NOT_AVAILABLE", "Posting error"));
    const res = await request("send");
    expect(res.statusCode).toBe(422);
    expect(ObligationService.prototype.remittanceSend).toHaveBeenCalledOnce();
    expect(writer).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
  });

  it.each(["send", "receive"] as const)("lets an explicit test shop %s without recording a refusal", async direction => {
    await markTestShop(handle.db);
    vi.mocked(ObligationService.prototype.remittanceSend).mockResolvedValueOnce({ transactionId: "mock-send" });
    vi.mocked(ObligationService.prototype.remittanceReceive).mockResolvedValueOnce({ transactionId: "mock-receive" });
    const res = await request(direction);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ transactionId: `mock-${direction}` });
    expect(await events()).toHaveLength(0);
  });

  it("does not mislabel a capability database failure as a real-shop refusal or allow posting", async () => {
    vi.spyOn(transferGate, "assertTransfersAvailable").mockRejectedValueOnce(new Error("database unavailable"));
    const writer = vi.spyOn(auditWriter, "audit");
    const res = await request("send");
    expect(res.statusCode).toBe(500);
    expect(writer).not.toHaveBeenCalled();
    expect(ObligationService.prototype.remittanceSend).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
  });
});
