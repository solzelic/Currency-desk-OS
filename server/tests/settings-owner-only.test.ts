/* A teller session must not be able to move owner-only settings.

   The live failure: a teller cookie PUT the desk snapshot and the
   large-cash threshold went from 10000 to 999999. The ledger route
   already refused that write. The snapshot did not. These tests cover
   the snapshot, the public-site patch, and the catalogue a settings
   search is allowed to offer. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { OWNER_ONLY_REFUSAL, ownsSettings } from "../src/state/owner-settings.js";

let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string>;
let teller: Record<string, string>;
let manager: Record<string, string>;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const settings = {
  threshold: 10000,
  idRequiredOver: 3000,
  retentionYears: 5,
  aggHours: 24,
  aggWindowStart: "00:00",
  regime: "CA",
  bizName: "York Foreign Exchange Inc.",
  baseCurrency: "CAD",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "12h",
  bizCountry: "Canada",
  billingPlan: "premium",
  billingCycle: "monthly",
  timezone: "America/Toronto",
  hours: [{ days: "Mon–Fri", hours: "9:30am–6:00pm" }],
};

const baseline = {
  cdos_rows_v1: [{ id: "kept" }],
  cdos_settings: settings,
  cdos_perms: { Teller: { canSettings: false, canDelete: true } },
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const login = (staffId: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId } });
  owner = cookieOf(await login("j.masri"));
  teller = cookieOf(await login("m.costa"));
  manager = cookieOf(await login("r.haddad"));
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, DEMO.tenantId));
  await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.tenantId, DEMO.tenantId));
  await handle.db.update(schema.tenants).set({ siteConfig: null }).where(eq(schema.tenants.id, DEMO.tenantId));
  const saved = await app.inject({
    method: "PUT",
    url: "/api/tenant/state",
    cookies: owner,
    payload: { state: baseline, version: 0 },
  });
  expect(saved.statusCode).toBe(200);
  await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.tenantId, DEMO.tenantId));
});

const read = () => app.inject({ method: "GET", url: "/api/tenant/state", cookies: teller });

const put = (cookies: Record<string, string>, state: Record<string, unknown>) =>
  app.inject({
    method: "PUT",
    url: "/api/tenant/state",
    cookies,
    payload: { state, version: 1 },
  });

describe("owner-only settings", () => {
  it("is the owner's permission and nobody else's", () => {
    expect(ownsSettings("administrator")).toBe(true);
    for (const role of ["teller", "supervisor", "compliance_officer", "branch_manager", "auditor"]) {
      expect(ownsSettings(role)).toBe(false);
    }
  });

  it.each([
    ["the large-cash threshold", { threshold: 999999 }, "threshold"],
    ["shop settings", { bizName: "Not York" }, "bizName"],
    ["localization", { baseCurrency: "USD" }, "baseCurrency"],
    ["billing", { billingPlan: "basic" }, "billingPlan"],
    ["hours", { hours: [{ days: "Never", hours: "closed" }] }, "hours"],
    ["timezone", { timezone: "Pacific/Auckland" }, "timezone"],
  ])("a teller PUT of %s is refused and nothing is written", async (_name, patch, field) => {
    const attack = {
      ...baseline,
      cdos_rows_v1: [{ id: "smuggled" }],
      cdos_settings: { ...settings, ...patch },
    };
    const denied = await put(teller, attack);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe(OWNER_ONLY_REFUSAL);

    const back = await read();
    expect(back.json().state).toEqual(baseline);
    expect(back.json().version).toBe(1);
    expect(back.json().state.cdos_settings[field]).toEqual(settings[field as keyof typeof settings]);

    const audits = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.owner_only_refused"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ fields: [field] });
  });

  it("a teller PUT of role presets is refused and nothing is written", async () => {
    const denied = await put(teller, {
      ...baseline,
      cdos_rows_v1: [{ id: "smuggled" }],
      cdos_perms: { Teller: { canSettings: true, canDelete: true } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe(OWNER_ONLY_REFUSAL);
    expect((await read()).json().state).toEqual(baseline);
    const audits = await handle.db.select().from(schema.auditEvents);
    expect(audits.map((row) => row.action)).toEqual(["settings.owner_only_refused"]);
    expect(audits[0]?.detail).toMatchObject({ groups: ["rolePresets"], fields: ["cdos_perms"] });
  });

  it("refuses the threshold when it arrives as the browser's JSON string", async () => {
    const denied = await put(teller, {
      ...baseline,
      cdos_settings: JSON.stringify({ ...settings, threshold: 999999 }),
    });
    expect(denied.statusCode).toBe(403);
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
  });

  it("a teller PATCH of the threshold does not change it", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/tenant",
      cookies: teller,
      payload: { threshold: 999999 },
    });
    expect(patched.statusCode).toBe(400);
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
  });

  it("a teller PATCH of public hours is refused, audited, and not published", async () => {
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/tenant",
      cookies: teller,
      payload: { siteConfig: { phone: "555", hours: [{ days: "Mon", hours: "1-2" }] } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe("You can't change the public site. Nothing was saved.");
    const row = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0];
    expect(row?.siteConfig).toBeNull();
    const audits = await handle.db.select().from(schema.auditEvents);
    expect(audits[0]?.detail).toMatchObject({ groups: ["hours"], fields: ["phone", "hours"] });
  });

  it("a manager is refused the threshold too", async () => {
    const denied = await put(manager, {
      ...baseline,
      cdos_settings: { ...settings, threshold: 999999 },
    });
    expect(denied.statusCode).toBe(403);
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
  });

  it("the owner can move the threshold, and a teller can save other work", async () => {
    const moved = await put(owner, {
      ...baseline,
      cdos_settings: { ...settings, threshold: 8000 },
    });
    expect(moved.statusCode).toBe(200);

    const echoed = await app.inject({
      method: "PUT",
      url: "/api/tenant/state",
      cookies: teller,
      payload: {
        state: {
          ...baseline,
          cdos_settings: { ...settings, threshold: 8000 },
          cdos_theme: "dark",
        },
        version: 2,
      },
    });
    expect(echoed.statusCode).toBe(200);
    const back = (await read()).json();
    expect(back.state.cdos_settings.threshold).toBe(8000);
    expect(back.state.cdos_theme).toBe("dark");
    const audits = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.owner_only_refused"));
    expect(audits).toHaveLength(0);
  });

  it("does not offer owner-only rows to a teller", async () => {
    const asTeller = (await read()).json();
    expect(asTeller.settingsRows).toEqual([]);
    expect(asTeller.state.cdos_settings.threshold).toBe(10000);

    const asOwner = (await app.inject({ method: "GET", url: "/api/tenant/state", cookies: owner })).json();
    const ids = asOwner.settingsRows.map((row: { id: string }) => row.id);
    expect(ids).toEqual(["shop", "compliance", "localization", "billing", "hours", "rolePresets"]);
  });
});
