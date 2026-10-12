/* A teller session must not be able to move owner-only settings.

   The live failure: a teller cookie PUT the desk snapshot and the
   large-cash threshold went from 10000 to 999999. A later failure: every
   teller sign-in was refused, because the shell rewrites role presets
   and copies the plan into billingPlan. Omitting those is not a change.
   Sending a different owner-only value still refuses the whole save. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { OWNER_ONLY_FIELDS, OWNER_ONLY_REFUSAL, NON_OWNER_MAY_CHANGE, MANAGER_MAY_CHANGE, ownsSettings } from "../src/state/owner-settings.js";

let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string>;
let teller: Record<string, string>;
let manager: Record<string, string>;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const seedValue = (field: string): unknown => {
  if (field === "hours") return [{ days: "Mon–Fri", hours: "9:30am–6:00pm" }];
  if (field === "threshold" || field === "idRequiredOver") return 10000;
  if (field === "aggHours") return 24;
  if (field === "structuringDays" || field === "reverifyDays" || field === "recheckDays" || field === "retentionYears") return 5;
  if (field === "defaultSpread") return 1.5;
  if (field === "requireIdPhoto" || field === "escalateHighRisk" || field === "screenSanctions" || field === "requireCountOnHandoff") return false;
  if (field === "largeTxCheck") return "off";
  return `seed-${field}`;
};

const changedValue = (field: string, current: unknown): unknown => {
  if (field === "hours") return [{ days: "Never", hours: "closed" }];
  if (typeof current === "number") return current + 7;
  if (typeof current === "boolean") return !current;
  return `changed-${field}`;
};

const settings = Object.fromEntries(OWNER_ONLY_FIELDS.map((field) => [field, seedValue(field)]));

const baseline = {
  cdos_rows_v1: [{ id: "kept" }],
  cdos_settings: { ...settings, staff: { "M. Costa": { email: "costa@yorkfx.ca" } } },
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

const put = (cookies: Record<string, string>, state: Record<string, unknown>, version = 1) =>
  app.inject({
    method: "PUT",
    url: "/api/tenant/state",
    cookies,
    payload: { state, version },
  });

const refusalAudits = () =>
  handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "settings.owner_only_refused"));

describe("owner-only settings", () => {
  it("is the owner's permission and nobody else's", () => {
    expect(ownsSettings("administrator")).toBe(true);
    for (const role of ["teller", "supervisor", "compliance_officer", "branch_manager", "auditor"]) {
      expect(ownsSettings(role)).toBe(false);
    }
    expect(NON_OWNER_MAY_CHANGE).not.toContain("threshold");
    expect(NON_OWNER_MAY_CHANGE).not.toContain("defaultSpread");
    expect(NON_OWNER_MAY_CHANGE).not.toContain("requireCountOnHandoff");
    expect(MANAGER_MAY_CHANGE).toContain("defaultSpread");
    expect(MANAGER_MAY_CHANGE).not.toContain("threshold");
  });

  it.each(OWNER_ONLY_FIELDS)("a teller cannot change %s, and the owner can", async (field) => {
    const next = changedValue(field, settings[field]);
    const attack = {
      ...baseline,
      cdos_rows_v1: [{ id: "smuggled" }],
      cdos_settings: { ...baseline.cdos_settings, [field]: next },
    };
    const denied = await put(teller, attack);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe(OWNER_ONLY_REFUSAL);
    expect((await read()).json().state).toEqual(baseline);
    const audits = await refusalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ fields: [field] });

    const moved = await put(owner, {
      ...baseline,
      cdos_settings: { ...baseline.cdos_settings, [field]: next },
    });
    expect(moved.statusCode).toBe(200);
    expect((await read()).json().state.cdos_settings[field]).toEqual(next);
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
    const audits = await refusalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ groups: ["rolePresets"], fields: ["cdos_perms"] });
  });

  it("refuses a settings field that is not on the allowlist", async () => {
    const denied = await put(teller, {
      ...baseline,
      cdos_settings: { ...baseline.cdos_settings, surprisePolicy: "yes" },
    });
    expect(denied.statusCode).toBe(403);
    expect((await read()).json().state).toEqual(baseline);
    expect(await refusalAudits()).toHaveLength(1);
  });

  it("refuses the threshold when it arrives as the browser's JSON string", async () => {
    const denied = await put(teller, {
      ...baseline,
      cdos_settings: JSON.stringify({ ...baseline.cdos_settings, threshold: 999999 }),
    });
    expect(denied.statusCode).toBe(403);
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
  });

  it("omitting the derived keys saves the rest and keeps the stored values", async () => {
    const withoutPlan = { ...baseline.cdos_settings } as Record<string, unknown>;
    delete withoutPlan.billingPlan;
    const { cdos_perms: _perms, ...withoutPerms } = baseline;
    const saved = await put(teller, {
      ...withoutPerms,
      cdos_settings: { ...withoutPlan, staff: { "M. Costa": { email: "m@yorkfx.ca" } } },
      cdos_clients_v1: { "Ada": { name: "Ada" } },
      cdos_day: { closed: false, num: 2 },
    });
    expect(saved.statusCode).toBe(200);
    const back = (await read()).json().state;
    expect(back.cdos_settings.billingPlan).toBe(settings.billingPlan);
    expect(back.cdos_settings.threshold).toBe(10000);
    expect(back.cdos_perms).toEqual(baseline.cdos_perms);
    expect(back.cdos_clients_v1).toEqual({ Ada: { name: "Ada" } });
    expect(back.cdos_day).toEqual({ closed: false, num: 2 });
    expect(back.cdos_settings.staff).toEqual({ "M. Costa": { email: "m@yorkfx.ca" } });
    expect(await refusalAudits()).toHaveLength(0);
  });

  it("an echoed owner-only field is not a change", async () => {
    const echoed = await put(teller, {
      ...baseline,
      cdos_theme: "dark",
    });
    expect(echoed.statusCode).toBe(200);
    expect((await read()).json().state.cdos_theme).toBe("dark");
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
    expect(await refusalAudits()).toHaveLength(0);
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
    const audits = await refusalAudits();
    expect(audits[0]?.detail).toMatchObject({ groups: ["hours"], fields: ["phone", "hours"] });
  });

  it("a manager publishes public contact and hours, and cannot move the threshold", async () => {
    const published = await app.inject({
      method: "PATCH",
      url: "/api/tenant",
      cookies: manager,
      payload: { siteConfig: { phone: "416-555-0199", hours: [{ days: "Mon–Fri", hours: "9–5" }] } },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().tenant.siteConfig.phone).toBe("416-555-0199");
    const row = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId)))[0];
    expect(row?.siteConfig).toMatchObject({ phone: "416-555-0199" });

    const denied = await put(manager, {
      ...baseline,
      cdos_settings: { ...baseline.cdos_settings, threshold: 999999 },
    });
    expect(denied.statusCode).toBe(403);
    expect((await read()).json().state.cdos_settings.threshold).toBe(10000);
  });

  it("a manager can save the default spread, and a teller cannot", async () => {
    const denied = await put(teller, {
      ...baseline,
      cdos_settings: { ...baseline.cdos_settings, defaultSpread: 2.5 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe(OWNER_ONLY_REFUSAL);
    expect((await read()).json().state.cdos_settings.defaultSpread).toBe(1.5);
    const audits = await refusalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ groups: ["rates"], fields: ["defaultSpread"] });

    const saved = await put(manager, {
      ...baseline,
      cdos_settings: { ...baseline.cdos_settings, defaultSpread: 2.5 },
    });
    expect(saved.statusCode).toBe(200);
    expect((await read()).json().state.cdos_settings.defaultSpread).toBe(2.5);
    expect(await refusalAudits()).toHaveLength(1);
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
