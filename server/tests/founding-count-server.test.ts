/* The founding count ignores a client field. stagingFresh on a public
   application still counts. Only a staging-door row, or a test shop, is left out.
   The admin overview uses that same rule. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forgetClaimedCount } from "../src/routes/early-access.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string>;

const claimed = async () => (await app.inject({ method: "GET", url: "/api/site/early-access" })).json().claimed as number;
const overview = async () => (await app.inject({ method: "GET", url: "/api/admin/overview", cookies: adminCookie })).json();

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
  adminCookie = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
});

afterAll(async () => {
  await app.close();
  await handle.close();
  vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("founding count uses server data", () => {
  it("counts a public enquiry that carries stagingFresh, and not a staging-door row", async () => {
    const before = await claimed();
    const desksBefore = (await overview()).totals.desks as number;

    const sent = await app.inject({
      method: "POST", url: "/api/enquiries",
      payload: { kind: "early_access", email: "public-fresh@shop.test", name: "Public", details: { stagingFresh: true, city: "Toronto" } },
    });
    expect(sent.statusCode).toBe(201);
    const stored = (await handle.db.select().from(schema.enquiries)).find((row) => row.email === "public-fresh@shop.test");
    expect(stored?.details && "stagingFresh" in (stored.details as object)).toBe(false);
    expect(await claimed()).toBe(before + 1);

    await handle.db.insert(schema.enquiries).values({
      id: randomUUID(), reference: "CD-SPOOF1", kind: "early_access", email: "spoof@shop.test",
      status: "reviewing", details: { stagingFresh: true },
    });
    forgetClaimedCount();
    expect(await claimed()).toBe(before + 2);

    await handle.db.insert(schema.enquiries).values({
      id: randomUUID(), reference: "CD-DOOR01", kind: "early_access", email: "owner+door@staging.invalid",
      status: "invited", charterNo: null, isDemo: false, doNotContact: true, doNotContactReason: "staging test shop",
      details: { slug: "stg-door0001" },
    });
    forgetClaimedCount();
    expect(await claimed()).toBe(before + 2);

    await handle.db.insert(schema.tenants).values({ id: "tnt-count-test", name: "Counted out", plan: "trial", isTestShop: true });
    forgetClaimedCount();
    expect(await claimed()).toBe(before + 2);

    const ov = await overview();
    expect(ov.funnel.applications).toBe(2);
    expect(ov.totals.desks).toBe(desksBefore);
  });
});
