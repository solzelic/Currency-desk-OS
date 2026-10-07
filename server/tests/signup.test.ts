/* Signup + email-OTP — full HTTP app against embedded PGlite.
   The code is read from the server log (simulated email), so no provider. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resetSignupThrottle, signupIpMax } from "../src/routes/signup.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

// capture the simulated-email log line so we can read the code
beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  /* This file is about the signup mechanics — the OTP, the tenant, slug
     collisions. Early access being invite-only is a separate rule, covered
     in funnel.test.ts; open the door so it does not mask these. */
  process.env.EARLY_ACCESS_OPEN = "1";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.EARLY_ACCESS_OPEN; });
beforeEach(() => { logged = []; });

// the signup code and the sign-in code are worded differently; take either
const codeFromLog = (): string => {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!m) throw new Error("no code in log: " + JSON.stringify(logged));
  return m[1]!;
};
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

describe("signup", () => {
  it("creates NO tenant until the emailed code is verified", async () => {
    const before = (await handle.db.select().from(schema.tenants)).length;
    const res = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Maple FX", ownerName: "Dana Kim", email: "dana@maplefx.ca", password: "a-strong-pass", slug: "maplefx" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, email: "dana@maplefx.ca" });
    // held in pending, no tenant yet
    expect((await handle.db.select().from(schema.tenants)).length).toBe(before);
    expect((await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, "dana@maplefx.ca"))).length).toBe(1);
  });

  it("wrong code is rejected; the right one creates the tenant + owner and signs in", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "dana@maplefx.ca", code: "000000" } });
    expect(wrong.statusCode).toBe(401);

    // re-issue a known code and read it from the log
    await app.inject({ method: "POST", url: "/api/signup/resend", payload: { email: "dana@maplefx.ca" } });
    const code = codeFromLog();
    const ok = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "dana@maplefx.ca", code } });
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body.tenant).toMatchObject({ slug: "maplefx", name: "Maple FX" });
    expect(body.tenant.plan).toBe(body.user.plan); // consistent entitlement
    expect(body.user).toMatchObject({ id: "dana@maplefx.ca", role: "administrator", tenantId: "tnt-maplefx" });
    expect(cookieOf(ok).cdos_session).toBeTruthy();

    // the tenant, owner, and audit exist; the pending row is gone
    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-maplefx"))).length).toBe(1);
    const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "dana@maplefx.ca"));
    expect(owner[0]).toMatchObject({ role: "administrator", tenantId: "tnt-maplefx" });
    expect((await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, "dana@maplefx.ca"))).length).toBe(0);
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("tenant.created");
  });

  it("the new owner can then log in to THEIR tenant", async () => {
    // the owner's staff id is their email, so signing in means the code step —
    // the password alone is not a way in
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "dana@maplefx.ca", password: "a-strong-pass" } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ needsCode: true });

    const login = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: "dana@maplefx.ca", code: codeFromLog() } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ id: "dana@maplefx.ca", tenantId: "tnt-maplefx", role: "administrator" });
  });

  it("carries the guided-onboarding config onto the new tenant", async () => {
    const onboarding = { country: "Canada", regulator: "FINTRAC", homeCurrency: "CAD", msbNumber: "M99-1234567", plan: "pro" as const, idThreshold: 5000 };
    const su = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Aspen FX", ownerName: "Sam Lee", email: "sam@aspenfx.ca", password: "a-strong-pass", slug: "aspenfx", onboarding } });
    expect(su.statusCode).toBe(201);
    const code = codeFromLog();
    const ok = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@aspenfx.ca", code } });
    expect(ok.statusCode).toBe(201);

    const t = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-aspenfx")))[0]!;
    expect(t.plan).toBe("pro");
    expect(t.setup).toMatchObject({ regulator: "FINTRAC", idThreshold: 5000, msbNumber: "M99-1234567" });
    const le = await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-aspenfx"));
    expect(le[0]!.msbNumber).toBe("M99-1234567");
  });

  it("does not label an unnamed regulator FINTRAC or open a CAD board", async () => {
    const su = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Beograd FX",
        ownerName: "Ana Petrovic",
        email: "ana@beogradfx.rs",
        password: "a-strong-pass",
        slug: "beogradfx",
        onboarding: { country: "RS" },
      },
    });
    expect(su.statusCode).toBe(201);
    await handle.db.insert(schema.marketRates).values({
      id: "snap-signup-rs",
      provider: "test",
      mids: { USD: 1.36, EUR: 1.25, GBP: 1.7, RSD: 0.0125 },
      fetchedAt: new Date(),
    });
    const ok = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "ana@beogradfx.rs", code: codeFromLog() },
    });
    expect(ok.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-beogradfx")))[0]!;
    expect(le.jurisdiction).toBe("");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.jurisdictionPackId).toBe("pack-rs-v1");
    expect(le.homeCurrency).toBe("RSD");
    expect(le.homeCurrency).not.toBe("CAD");
    expect(le.homeCurrency).not.toBe("USD");
    const boards = await handle.db.select().from(schema.rateBoards).where(eq(schema.rateBoards.branchId, "br-beogradfx-main"));
    expect(boards).toHaveLength(1);
    expect(boards[0]!.boardRows.CAD).toBeUndefined();
  });

  it("opens a new India desk on the India pack, in rupees", async () => {
    const su = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Mumbai FX",
        ownerName: "Priya Shah",
        email: "priya@mumbaifx.in",
        password: "a-strong-pass",
        slug: "mumbaifx",
        onboarding: { country: "IN" },
      },
    });
    expect(su.statusCode).toBe(201);
    const ok = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "priya@mumbaifx.in", code: codeFromLog() },
    });
    expect(ok.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-mumbaifx")))[0]!;
    expect(le.jurisdictionPackId).toBe("pack-in-v1");
    expect(le.homeCurrency).toBe("INR");
    /* The signup body did not send a regulator string. The column stays
       blank rather than being labelled FINTRAC. Settings reads the
       regulator off the pack, which is RBI / FIU-IND. */
    expect(le.jurisdiction).toBe("");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.jurisdictionPackId).not.toBe("pack-intl-v1");
    expect(le.homeCurrency).not.toBe("CAD");
  });

  it("opens a new Philippines desk on the Philippines pack, in pesos", async () => {
    const su = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Manila FX",
        ownerName: "Liza Cruz",
        email: "liza@manilafx.ph",
        password: "a-strong-pass",
        slug: "manilafx",
        onboarding: { country: "PH" },
      },
    });
    expect(su.statusCode).toBe(201);
    const ok = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "liza@manilafx.ph", code: codeFromLog() },
    });
    expect(ok.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-manilafx")))[0]!;
    expect(le.jurisdictionPackId).toBe("pack-ph-v1");
    expect(le.homeCurrency).toBe("PHP");
    /* The signup body did not send a regulator string. The column stays
       blank rather than being labelled FINTRAC. Settings reads the
       regulator off the pack, which is BSP / AMLC. */
    expect(le.jurisdiction).toBe("");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.jurisdictionPackId).not.toBe("pack-intl-v1");
    expect(le.homeCurrency).not.toBe("CAD");
  });

  it("opens a Singapore desk on pack-sg-v1 in SGD, not on Canada", async () => {
    const su = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Raffles FX",
        ownerName: "Mei Tan",
        email: "mei@rafflesfx.sg",
        password: "a-strong-pass",
        slug: "rafflesfx",
        onboarding: { country: "SG" },
      },
    });
    expect(su.statusCode).toBe(201);
    const ok = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "mei@rafflesfx.sg", code: codeFromLog() },
    });
    expect(ok.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-rafflesfx")))[0]!;
    expect(le.jurisdictionPackId).toBe("pack-sg-v1");
    expect(le.homeCurrency).toBe("SGD");
    /* The signup body did not send a regulator string. The column stays
       blank rather than being labelled FINTRAC. Settings reads the
       regulator off the pack, which is MAS / STRO. */
    expect(le.jurisdiction).toBe("");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.jurisdictionPackId).not.toBe("pack-intl-v1");
    expect(le.homeCurrency).not.toBe("CAD");
    expect(le.idThreshold).toBeNull();
  });

  it("rejects a taken slug and a reserved slug", async () => {
    const taken = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Other", ownerName: "X", email: "x@other.ca", password: "a-strong-pass", slug: "yorkfx" } });
    expect(taken.statusCode).toBe(409); // yorkfx is the seeded tenant
    const reserved = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Other", ownerName: "X", email: "y@other.ca", password: "a-strong-pass", slug: "admin" } });
    expect(reserved.statusCode).toBe(409);
  });

  it("rejects an email that already owns a desk", async () => {
    const dup = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Dupe", ownerName: "Dana", email: "dana@maplefx.ca", password: "a-strong-pass", slug: "maplefx2" } });
    expect(dup.statusCode).toBe(409);
  });

  it("allows eight signups from one address an hour when SIGNUP_IP_MAX is unset", async () => {
    const prior = process.env.SIGNUP_IP_MAX;
    delete process.env.SIGNUP_IP_MAX;
    resetSignupThrottle();
    try {
      expect(signupIpMax()).toBe(8);
      process.env.SIGNUP_IP_MAX = " ";
      expect(signupIpMax()).toBe(8);
      process.env.SIGNUP_IP_MAX = "16.5";
      expect(signupIpMax()).toBe(8);
      delete process.env.SIGNUP_IP_MAX;
      for (let i = 0; i < 8; i += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/signup",
          payload: {
            businessName: `Limit ${i}`,
            ownerName: "Limit Owner",
            email: `limit-${i}@signup-cap.example`,
            password: "a-strong-pass",
            slug: `limitcap${i}`,
          },
        });
        expect(res.statusCode, res.body).not.toBe(429);
      }
      const blocked = await app.inject({
        method: "POST",
        url: "/api/signup",
        payload: {
          businessName: "Limit 8",
          ownerName: "Limit Owner",
          email: "limit-8@signup-cap.example",
          password: "a-strong-pass",
          slug: "limitcap8",
        },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("slow_down");
    } finally {
      resetSignupThrottle();
      if (prior === undefined) delete process.env.SIGNUP_IP_MAX;
      else process.env.SIGNUP_IP_MAX = prior;
    }
  });

  it("validates the form (bad email, short password, bad slug)", async () => {
    for (const payload of [
      { businessName: "A", ownerName: "B", email: "notanemail", password: "a-strong-pass", slug: "okslug" },
      { businessName: "A", ownerName: "B", email: "ok@ok.ca", password: "short", slug: "okslug" },
      { businessName: "A", ownerName: "B", email: "ok2@ok.ca", password: "a-strong-pass", slug: "-bad-" },
    ]) {
      const r = await app.inject({ method: "POST", url: "/api/signup", payload });
      expect(r.statusCode).toBe(400);
    }
  });
});
