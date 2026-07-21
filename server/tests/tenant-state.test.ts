/* Tenant state store — the OS's per-desk snapshot, saved server-side and
   strictly isolated per tenant. Auth is via the real login + signup flows. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => { logged = []; });

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/);
  if (!m) throw new Error("no code in log");
  return m[1]!;
};
const cookieHeader = (res: { cookies: { name: string; value: string }[] }): string => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? `cdos_session=${c.value}` : "";
};

// sign in the seeded York FX administrator
async function yorkCookie(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
  expect(res.statusCode).toBe(200);
  return cookieHeader(res);
}
// create a brand-new desk via the real signup + email-verify flow
async function newDeskCookie(slug: string): Promise<string> {
  const email = `${slug}@statetest.ca`;
  await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: slug + " FX", ownerName: "Owner", email, password: "a-strong-pass", slug } });
  const verify = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email, code: codeFromLog() } });
  expect(verify.statusCode).toBe(201);
  return cookieHeader(verify);
}

describe("tenant state", () => {
  it("requires a session", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/tenant/state" });
    expect(anon.statusCode).toBe(401);
    const put = await app.inject({ method: "PUT", url: "/api/tenant/state", payload: { state: {} } });
    expect(put.statusCode).toBe(401);
  });

  it("starts empty, then round-trips the saved snapshot", async () => {
    const cookie = await yorkCookie();
    const empty = await app.inject({ method: "GET", url: "/api/tenant/state", headers: { cookie } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().state).toBeNull(); // never saved yet

    const snapshot = { cdos_rows_v1: [{ id: "t1", amount: 500 }], cdos_settings: { deskName: "Yorkville Desk" }, yorkfx_rates_v1: { USD: 1.37 } };
    const save = await app.inject({ method: "PUT", url: "/api/tenant/state", headers: { cookie }, payload: { state: snapshot } });
    expect(save.statusCode).toBe(200);
    expect(save.json().ok).toBe(true);

    const back = await app.inject({ method: "GET", url: "/api/tenant/state", headers: { cookie } });
    expect(back.json().state).toEqual(snapshot);
    expect(back.json().updatedAt).toBeTruthy();
  });

  it("keeps each tenant's state completely isolated", async () => {
    const york = await yorkCookie();
    const aspen = await newDeskCookie("aspenstate");

    // the brand-new desk sees NOTHING of York's saved state
    const aspenEmpty = await app.inject({ method: "GET", url: "/api/tenant/state", headers: { cookie: aspen } });
    expect(aspenEmpty.json().state).toBeNull();

    // each writes its own; neither leaks into the other
    await app.inject({ method: "PUT", url: "/api/tenant/state", headers: { cookie: aspen }, payload: { state: { desk: "aspen" } } });
    await app.inject({ method: "PUT", url: "/api/tenant/state", headers: { cookie: york }, payload: { state: { desk: "york" } } });
    const a = await app.inject({ method: "GET", url: "/api/tenant/state", headers: { cookie: aspen } });
    const y = await app.inject({ method: "GET", url: "/api/tenant/state", headers: { cookie: york } });
    expect(a.json().state).toEqual({ desk: "aspen" });
    expect(y.json().state).toEqual({ desk: "york" });

    // one row per tenant — an upsert, not an append
    const rows = await handle.db.select().from(schema.tenantState);
    const forAspen = rows.filter((r) => r.tenantId === "tnt-aspenstate");
    expect(forAspen.length).toBe(1);
  });
});
