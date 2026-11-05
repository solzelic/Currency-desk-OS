/* Who may change the shop's pricing settings.

   Rates v2.5 (the design's "Plans and roles"): tellers can view only;
   the cost method and the guardrails are the owner's. Before this, any
   role could change every pricing key in the desk document (spreads,
   pinned rates, the fee, rounding, the floor and target), because they
   were on the teller allowlist, while Settings told a teller "Only the
   owner can change rates and fees".

   Now:
   - a teller changes none of them;
   - a manager prices: spreads, pinned rates, the fee, rounding, the
     rate-hold time, the feed name and the default spread;
   - the guardrails (target, floor, what happens below it) are the
     owner's alone.
   A refused save is refused whole, as for every owner-only field. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { MANAGER_MAY_CHANGE, NON_OWNER_MAY_CHANGE, OWNER_ONLY_REFUSAL } from "../src/state/owner-settings.js";

let handle: DbHandle;
let app: FastifyInstance;
const who: Record<string, Record<string, string>> = {};

const PRICING = ["spreads", "spotOverride", "defaultFee", "feeTiers", "rateRounding", "rateLockMins", "payoutRoundTo", "payoutRoundMode", "rateProvider"] as const;
const GUARDRAILS = ["marginTargetPct", "marginFloorPct", "marginEnforce"] as const;

const start: Record<string, unknown> = {
  spreads: { USD: 1.2 }, spotOverride: {}, defaultFee: 2, feeTiers: [], rateRounding: 4, rateLockMins: 15,
  payoutRoundTo: 0.01, payoutRoundMode: "nearest", rateProvider: "OANDA",
  marginTargetPct: 1, marginFloorPct: 0.5, marginEnforce: "block", defaultSpread: 1.5,
};
const changed: Record<string, unknown> = {
  spreads: { USD: 2.4 }, spotOverride: { USD: 1.31 }, defaultFee: 9, feeTiers: [{ over: 10000, fee: 25 }], rateRounding: 2, rateLockMins: 60,
  payoutRoundTo: 5, payoutRoundMode: "down", rateProvider: "XE Currency Data",
  marginTargetPct: 0.1, marginFloorPct: 0, marginEnforce: "warn", defaultSpread: 0.9,
};
const baseline = { cdos_settings: start };

const put = (staffId: string, state: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/tenant/state", cookies: who[staffId], payload: { state, version: 1 } });
const stored = async () => (await app.inject({ method: "GET", url: "/api/tenant/state", cookies: who["j.masri"] })).json().state.cdos_settings;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  for (const id of ["j.masri", "r.haddad", "m.costa"]) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: id, password: "yorkville", tenantId: DEMO.tenantId } });
    who[id] = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
  }
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
  const saved = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: who["j.masri"], payload: { state: baseline, version: 0 } });
  expect(saved.statusCode, saved.body).toBe(200);
});

describe("pricing settings and roles", () => {
  it("are not on the teller's list, and only the pricing keys are on the manager's", () => {
    for (const k of [...PRICING, ...GUARDRAILS]) expect(NON_OWNER_MAY_CHANGE).not.toContain(k);
    for (const k of PRICING) expect(MANAGER_MAY_CHANGE).toContain(k);
    for (const k of GUARDRAILS) expect(MANAGER_MAY_CHANGE).not.toContain(k);
  });

  it.each([...PRICING, ...GUARDRAILS, "defaultSpread"])("a teller cannot change %s, and nothing is saved", async (field) => {
    const res = await put("m.costa", { cdos_settings: { ...start, [field]: changed[field] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toBe(OWNER_ONLY_REFUSAL);
    expect((await stored())[field]).toEqual(start[field]);
  });

  it.each([...PRICING, "defaultSpread"])("a manager changes %s", async (field) => {
    const res = await put("r.haddad", { cdos_settings: { ...start, [field]: changed[field] } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await stored())[field]).toEqual(changed[field]);
  });

  it.each(GUARDRAILS)("a manager cannot change the guardrail %s; the owner can", async (field) => {
    const refused = await put("r.haddad", { cdos_settings: { ...start, [field]: changed[field] } });
    expect(refused.statusCode).toBe(403);
    expect((await stored())[field]).toEqual(start[field]);
    const moved = await put("j.masri", { cdos_settings: { ...start, [field]: changed[field] } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await stored())[field]).toEqual(changed[field]);
  });

  it("a teller saving the desk unchanged is not refused", async () => {
    const res = await put("m.costa", { cdos_settings: { ...start }, cdos_theme: "dark" });
    expect(res.statusCode, res.body).toBe(200);
  });
});
