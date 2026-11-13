/* The staging button starts the whole journey at the Early Access v2.1
   page (Sol, 13 Nov: "when you start a whole new shop, you should start
   from what I'm giving you right now and then running through the whole
   process"). It hands out a one-time ticket and a staging identity; the
   page applies with the ticket, the application is accepted at once, and
   "Start building your desk" opens the real setup. Nothing is emailed.
   Launch marks the tenant a test shop only when the staging door is open.
   A live host stays 404, and a ticket means nothing there. */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resetFreshShopThrottle } from "../src/routes/staging-fresh-shop.js";

const STAGING_HOST = "staging.currencydeskos.com";

/* What the v2.1 page posts, with the staging ticket it was opened with. */
const application = (email: string, door?: string) => ({
  kind: "early_access", form: "early-access-v2.1", email, name: "Staging Owner",
  ...(door ? { stagingDoor: door } : {}),
  details: {
    firstName: "Staging", lastName: "Owner", shopName: "Harbour Test", workspace: "harbour-test.currencydeskos.com",
    website: "none yet", mode: "early_access", jurisdiction: "CA", province: "ON", country: "Canada", state: null,
    fintracRegistered: "Yes", msbNumber: null, waitlist: false, waitlistReason: null, role: "Owner",
    employees: "2 to 5", monthlyVolume: "$2M to $10M", branches: "single", runningOn: "Spreadsheets", timeline: "This quarter",
    phone: "+1 4165550148", bestTime: "no call", samConsent: null,
  },
  contactContext: { timezone: "America/Toronto" },
});
const ticketOf = (start: string) => new URL(start, "https://x").searchParams.get("door") ?? "";
const saved = {
  STAGING: process.env.STAGING,
  IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  PGLITE_MEMORY: process.env.PGLITE_MEMORY,
};

function restoreEnv() {
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  resetFreshShopThrottle();
  vi.restoreAllMocks();
});

async function boot(flag: string | undefined, externalHost: string) {
  restoreEnv();
  process.env.PGLITE_MEMORY = "1";
  delete process.env.IS_PULL_REQUEST;
  if (flag === undefined) delete process.env.STAGING;
  else process.env.STAGING = flag;
  process.env.RENDER_EXTERNAL_HOSTNAME = externalHost;
  const handle = await createDb();
  await seed(handle.db);
  const app = await buildApp(handle.db, {}, new Writable({ write(_c, _e, cb) { cb(); } }));
  return { app, handle };
}

describe("fresh onboarding", () => {
  it("is absent on live and opens the real desk setup on staging", async () => {
    const closed = await boot(undefined, STAGING_HOST);
    try {
      expect(closed.app.hasRoute({ method: "POST", url: "/api/staging/fresh-onboarding" })).toBe(false);
    } finally {
      await closed.app.close();
      await closed.handle.close();
    }

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    const { app, handle } = await boot("1", STAGING_HOST);
    try {
      const live = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: "www.currencydeskos.com" } });
      expect(live.statusCode).toBe(404);

      const opened = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: STAGING_HOST } });
      expect(opened.statusCode).toBe(201);
      const door = opened.json() as { ok: boolean; start: string; email: string; reference?: string; password?: string; code?: string };
      expect(door.ok).toBe(true);
      expect(door.email).toMatch(/^owner\+[0-9a-f]+@staging\.invalid$/);
      /* the website first, as a new shop sees it (Sol, 14 Nov), with the ticket */
      expect(door.start).toMatch(/^\/\?door=[0-9a-f]{32}&email=owner%2B[0-9a-f]+%40staging\.invalid$/);
      expect(door.reference).toBeUndefined(); // nothing is applied for them: they apply on the page
      expect(door.password).toBeUndefined();
      expect(door.code).toBeUndefined();
      const before = (await handle.db.select().from(schema.enquiries)).length;

      /* the page applies with the ticket; whatever email was typed, the staging identity is used */
      const applied = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, payload: application("someone@example.com", ticketOf(door.start)) });
      expect(applied.statusCode, applied.body).toBe(201);
      const body = { ...(applied.json() as { reference: string; cdId: string; charterNo: number | null }), email: door.email };
      expect(body.cdId).toMatch(/^CD-HARB-[2-9A-HJKMNP-Z]{4}$/);
      expect(body.charterNo).toBeNull();
      expect((await handle.db.select().from(schema.enquiries)).length).toBe(before + 1);
      expect(lines.join("\n")).not.toContain("[email");
      expect(lines.join("\n")).not.toContain(body.email);

      const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, body.reference)))[0];
      expect(row?.email).toBe(door.email);
      expect(row?.status).toBe("invited");
      expect(row?.kind).toBe("early_access");
      expect(row?.isDemo).toBe(false);
      expect(row?.charterNo).toBeNull();
      expect(row?.doNotContact).toBe(true);
      expect((row?.details as { stagingFresh?: boolean; slug?: string }).stagingFresh).toBe(true);
      expect(String((row?.details as { slug?: string }).slug)).toMatch(/^stg-/);

      /* one application per ticket */
      const again = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, payload: application("again@example.com", ticketOf(door.start)) });
      expect(again.statusCode).toBe(400);

      const state = await app.inject({ method: "GET", url: "/api/onboarding/" + body.reference + "/state", headers: { host: STAGING_HOST } });
      expect(state.statusCode).toBe(200);
      expect(state.json().data.ownerEmail).toBe(body.email);

      await app.inject({
        method: "PUT", url: "/api/onboarding/" + body.reference + "/state", headers: { host: STAGING_HOST },
        payload: { at: 5, data: { country: "CA", operatingName: "Harbour Test", bizName: "Harbour Test Inc.", ownerName: "Staging owner", ownerEmail: body.email, plan: "full" } },
      });
      const sent = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/verify/send", headers: { host: STAGING_HOST },
        payload: { data: { ownerEmail: body.email, operatingName: "Harbour Test" } },
      });
      expect(sent.statusCode).toBe(200);
      const code = (sent.json() as { code?: string }).code;
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(lines.join("\n")).not.toContain(String(code));
      expect(sent.json().channel).toBe("email");

      const checked = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/verify/check", headers: { host: STAGING_HOST },
        payload: { code },
      });
      expect(checked.statusCode).toBe(200);

      const launch = await app.inject({
        method: "POST", url: "/api/onboarding/" + body.reference + "/launch", headers: { host: STAGING_HOST },
        payload: { data: { ownerPass: "north-yard-9", ownerEmail: body.email, operatingName: "Harbour Test", bizName: "Harbour Test Inc.", country: "CA", ownerName: "Staging owner", plan: "full" } },
      });
      expect(launch.statusCode).toBe(201);
      const tenantId = (launch.json() as { tenantId: string }).tenantId;
      const tenant = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0];
      expect(tenant?.isTestShop).toBe(true);
      expect(tenant?.siteSlug?.startsWith("stg-")).toBe(true);
      const owner = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, body.email)))[0];
      expect(owner?.mustChangePassword).toBe(false);
    } finally {
      await app.close();
      await handle.close();
    }
  });
});

describe("the staging ticket", () => {
  /* Only a saved application uses the ticket: a refusal before it is saved
     (here, too many from one address) leaves it for the next press. */
  it("is not spent by a refusal before the application is saved", async () => {
    const { app, handle } = await boot("1", STAGING_HOST);
    const before = process.env.ENQUIRY_IP_MAX;
    process.env.ENQUIRY_IP_MAX = "1";
    try {
      const { resetEnquiryThrottle } = await import("../src/routes/enquiries.js");
      resetEnquiryThrottle();
      const opened = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: STAGING_HOST } });
      const door = ticketOf((opened.json() as { start: string }).start);
      const first = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, remoteAddress: "198.51.100.70", payload: application("first@example.com") });
      expect(first.statusCode).toBe(201);
      const slowed = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, remoteAddress: "198.51.100.70", payload: application("x@example.com", door) });
      expect(slowed.statusCode).toBe(429);
      const again = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, remoteAddress: "198.51.100.71", payload: application("x@example.com", door) });
      expect(again.statusCode, again.body).toBe(201);
    } finally {
      if (before === undefined) delete process.env.ENQUIRY_IP_MAX; else process.env.ENQUIRY_IP_MAX = before;
      await app.close();
      await handle.close();
    }
  });

  it("means nothing on a live host, and a made-up ticket is refused", async () => {
    const { app, handle } = await boot("1", STAGING_HOST);
    try {
      const opened = await app.inject({ method: "POST", url: "/api/staging/fresh-onboarding", headers: { host: STAGING_HOST } });
      const door = ticketOf((opened.json() as { start: string }).start);

      const live = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: "www.currencydeskos.com" }, payload: application("live@example.com", door) });
      expect(live.statusCode).toBe(400);
      expect((await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "live@example.com")))).toHaveLength(0);

      const madeUp = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, payload: application("madeup@example.com", "0".repeat(32)) });
      expect(madeUp.statusCode).toBe(400);

      /* a staging address never applies as a real shop: without a ticket it is refused */
      const bare = await app.inject({ method: "POST", url: "/api/enquiries", headers: { host: STAGING_HOST }, payload: application("owner+ab12@staging.invalid") });
      expect(bare.statusCode).toBe(400);
      expect(bare.json().error).toBe("staging_ticket");
      expect(await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "owner+ab12@staging.invalid"))).toHaveLength(0);
    } finally {
      await app.close();
      await handle.close();
    }
  });
});
