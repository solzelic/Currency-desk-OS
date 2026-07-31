/* Knowing what is inside a desk's saved state.

   The document was validated as `z.record(z.unknown())` — a schema that
   accepts everything and verifies nothing — while forty-four keys were
   written into it by fifteen files. Nothing on the server knew the name of
   one of them.

   Two things are tested here, and the second matters more than it looks.
   First, that the description is accurate. Second, that the catalogue stays
   honest as the OS grows: a key added to the browser and not to the
   catalogue is caught here rather than discovered in a customer's data
   months later.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CATALOGUE, describe as describeState, summarise } from "../src/state/shape.js";

describe("describing a document", () => {
  it("splits the compliance record from the screen furniture", () => {
    const r = describeState({
      cdos_clients_v1: JSON.stringify({ "Jakob Miller": { kind: "individual", idType: "Passport" } }),
      cdos_app_order: JSON.stringify(["rates", "ledger"]),
    });
    expect(r.recordBytes).toBeGreaterThan(0);
    expect(r.preferenceBytes).toBeGreaterThan(0);
    // the clients file is the record; the app order is not
    expect(r.keys.find((k) => k.key === "cdos_clients_v1")?.kind).toBe("record");
    expect(r.keys.find((k) => k.key === "cdos_app_order")?.kind).toBe("preference");
  });

  /* The number that says how much promotion buys, and how we will know it
     is finished. */
  it("counts the record bytes, because that is the size of the problem", () => {
    const clients = JSON.stringify({ "A B": { kind: "individual" } });
    const r = describeState({ cdos_clients_v1: clients, cdos_theme: "dark" });
    expect(r.recordBytes).toBe(Buffer.byteLength(clients));
    expect(r.totalBytes).toBe(r.recordBytes + r.preferenceBytes);
  });

  it("names the biggest keys first, so a large desk can be looked at", () => {
    const r = describeState({
      cdos_theme: "dark",
      cdos_rows_v1: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i }))),
      cdos_app_order: JSON.stringify(["rates"]),
    });
    expect(r.keys[0]!.key).toBe("cdos_rows_v1");
  });

  it("reports a key nobody on the server has heard of", () => {
    const r = describeState({ cdos_something_new_v1: "{}" });
    expect(r.unknown).toEqual(["cdos_something_new_v1"]);
  });

  it("reports a value that does not match the shape we expect", () => {
    const r = describeState({ cdos_rows_v1: JSON.stringify({ notAnArray: true }) });
    expect(r.invalid).toContain("cdos_rows_v1");
    expect(r.keys.find((k) => k.key === "cdos_rows_v1")?.valid).toBe(false);
  });

  it("reports a value that is not JSON at all", () => {
    const r = describeState({ cdos_clients_v1: "{ broken" });
    expect(r.keys.find((k) => k.key === "cdos_clients_v1")?.issue).toBe("not valid JSON");
  });

  /* "We have not written a schema for this yet" is not the same as "this is
      wrong", and a report that conflates them teaches people to ignore it. */
  it("distinguishes 'no schema yet' from 'failed the schema'", () => {
    const r = describeState({ cdos_kyc_v1: "{}", cdos_rows_v1: '"nonsense"' });
    expect(r.keys.find((k) => k.key === "cdos_kyc_v1")?.valid).toBeNull();
    expect(r.keys.find((k) => k.key === "cdos_rows_v1")?.valid).toBe(false);
  });

  it("accepts the real seeded shapes without complaint", () => {
    const clients = {
      "Jakob Miller": { kind: "individual", idType: "Driver's Licence", idNum: "DL 8841-220", idExpiry: "2028-04-01", photo: null, email: "j@e.com", phone: "(416) 555-0142", dob: "1989-03-22", occupation: "Electrician", address: "88 Lansdowne Ave", city: "Toronto", province: "ON", postal: "M6K 2W2", risk: "Standard" },
      "Northbridge Imports": { kind: "corporate", idType: "Business Number", idNum: "BN 77120", incorpDate: "2014-02-18", jurisdiction: "Ontario, Canada", business: "Import / export", contactName: "Priya Nair", contactTitle: "Controller", risk: "Enhanced" },
    };
    const rows = [{ id: 1, ref: "LT-260618-001", date: "2026-06-18", time: "09:41", customer: "Jakob Miller", type: "Currency Exchange", inCcy: "CAD", inAmt: 2400, rate: 0.73, outCcy: "USD", outAmt: 1752, fee: 18, teller: "A. Singh", status: "posted", thread: [], filed: false }];
    const r = describeState({ cdos_clients_v1: JSON.stringify(clients), cdos_rows_v1: JSON.stringify(rows) });
    expect(r.invalid).toEqual([]);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => describeState({})).not.toThrow();
    expect(() => describeState({ a: null as unknown as string })).not.toThrow();
    expect(() => describeState({ cdos_rows_v1: 42 as unknown as string })).not.toThrow();
  });

  it("summarises in one line, for a log that runs on every save", () => {
    const s = summarise(describeState({ cdos_clients_v1: "{}", weird_key: "1" }));
    expect(s).toMatch(/KB/);
    expect(s).toMatch(/1 unknown: weird_key/);
  });
});

/* ---- the catalogue against the code that actually writes these -------- */

describe("the catalogue keeps up with the OS", () => {
  /* A key added in the browser and not here is exactly the drift this whole
     module exists to catch, so it must not be possible to add one quietly.

     Reads the shipped browser sources rather than a list — a list would be a
     second thing to remember, which is the problem, not the fix. */
  const keysInBrowserCode = (): Set<string> => {
    const dir = resolve(process.cwd(), "../os-src");
    const found = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!/\.(jsx|js)$/.test(f)) continue;
      const src = readFileSync(resolve(dir, f), "utf8");
      // localStorage.getItem('cdos_x') and friends
      for (const m of src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*['"]((?:cdos_|yorkfx_)[a-z0-9_]+)['"]/g)) found.add(m[1]!);
      // KEY constants: const TG_LKEY = 'cdos_tg_log_v2'
      for (const m of src.matchAll(/=\s*['"]((?:cdos_|yorkfx_)[a-z0-9_]+)['"]/g)) found.add(m[1]!);
    }
    return found;
  };

  /* Two keys are deliberately absent from the catalogue: the persistence
     bridge's own prefix test matches them, but they are session-scoped
     browser things that never reach the server document. */
  const NOT_SAVED = new Set(["yorkfx_staff_user", "yorkfx_staff_auth"]);

  it("has an entry for every key the browser writes", () => {
    const known = new Set(CATALOGUE.map((k) => k.key));
    const missing = [...keysInBrowserCode()].filter((k) => !known.has(k) && !NOT_SAVED.has(k));
    expect(missing, `add these to CATALOGUE in src/state/shape.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not describe keys that no longer exist", () => {
    const inCode = keysInBrowserCode();
    const stale = CATALOGUE.map((k) => k.key).filter((k) => !inCode.has(k));
    expect(stale, `these are catalogued but nothing writes them: ${stale.join(", ")}`).toEqual([]);
  });

  it("classifies every key, because that classification is the roadmap", () => {
    for (const k of CATALOGUE) {
      expect(["record", "preference"]).toContain(k.kind);
      expect(k.what.length).toBeGreaterThan(10); // a description somebody can read
    }
  });

  it("has no duplicates", () => {
    const keys = CATALOGUE.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/* ---- what the panel can see ------------------------------------------ */

describe("the shape of a desk, from the panel", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let admin: Record<string, string> = {};

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    process.env.SEED_PASSWORD = "yorkville";
    process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
    vi.spyOn(console, "log").mockImplementation(() => {});
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const c = r.cookies.find((x) => x.name === "cdos_session");
    admin = c ? { cdos_session: c.value } : {};
  });
  afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

  it("is the platform team's business only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-yorkfx/state-shape" });
    expect(res.statusCode).toBe(401);
  });

  it("says so plainly when a desk has never saved", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-yorkfx/state-shape", cookies: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(false);
  });

  it("reports sizes and shapes once there is something to report", async () => {
    await app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: admin,
      payload: { state: { cdos_clients_v1: JSON.stringify({ "A B": { kind: "individual" } }), cdos_theme: "dark" }, version: 0 },
    });
    const res = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-yorkfx/state-shape", cookies: admin });
    const body = res.json();
    expect(body.saved).toBe(true);
    expect(body.report.recordBytes).toBeGreaterThan(0);
    expect(body.report.keys.map((k: { key: string }) => k.key)).toContain("cdos_clients_v1");
  });

  /* A support screen that leaks the thing it is reporting on would be a
     poor trade. Names and byte counts, never a customer. */
  it("never returns anybody's data — only names and sizes", async () => {
    await app.inject({
      method: "PUT", url: "/api/tenant/state", cookies: admin,
      payload: { state: { cdos_clients_v1: JSON.stringify({ "Jakob Miller": { idNum: "DL 8841-220" } }) } },
    });
    const res = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-yorkfx/state-shape", cookies: admin });
    expect(res.body).not.toContain("Jakob Miller");
    expect(res.body).not.toContain("DL 8841-220");
  });
});

describe("a document nothing understands is still saved", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let cookies: Record<string, string> = {};

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    process.env.SEED_PASSWORD = "yorkville";
    vi.spyOn(console, "log").mockImplementation(() => {});
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const c = r.cookies.find((x) => x.name === "cdos_session");
    cookies = c ? { cdos_session: c.value } : {};
  });
  afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });

  /* The most important test in this file.

     The browser holds the only copy. A validator that refuses a document it
     merely finds surprising does not protect the desk — it destroys the data
     it was meant to protect, silently, which is the exact bug fixed in
     state/contract.ts. Describing must never become refusing. */
  it("saves a document full of keys and shapes the server does not recognise", async () => {
    const nonsense = {
      cdos_invented_key_v9: JSON.stringify({ anything: true }),
      cdos_rows_v1: JSON.stringify({ definitely: "not an array" }),
      cdos_clients_v1: "{ not even json",
    };
    const res = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies, payload: { state: nonsense } });
    expect(res.statusCode).toBe(200);

    const got = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
    expect(got.json().state).toEqual(nonsense);
  });
});
