/* The "N of 100 desks claimed" on the marketing site. It used to be the
   number the design was drawn with; it counts real applications now, so the
   thing it has to get right is what counts as a claim. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
const ADMIN = "j.masri";

const apply = (email: string) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "early_access", email, name: "A Shop" } as Record<string, unknown> });
const count = async () => (await app.inject({ method: "GET", url: "/api/site/early-access" })).json();

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (c) adminCookie = { cdos_session: c.value };
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("desks claimed", () => {
  it("counts the desks that already exist, before anybody applies", async () => {
    const c = await count();
    // York FX is a real desk and takes one of the hundred; the platform's own
    // tenant is not a customer and must not
    expect(c.claimed).toBe(1);
    expect(c.cap).toBe(100);
    expect(c.remaining).toBe(99);
    expect(c.full).toBe(false);
  });

  it("moves when somebody applies — the whole point", async () => {
    const before = (await count()).claimed;
    expect((await apply("first@shop.ca")).statusCode).toBe(201);
    expect((await count()).claimed).toBe(before + 1);
    expect((await apply("second@shop.ca")).statusCode).toBe(201);
    expect((await count()).claimed).toBe(before + 2);
  });

  it("gives the place back when the operator declines an application", async () => {
    const before = (await count()).claimed;
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "second@shop.ca")).limit(1))[0]!;
    // through the screen the operator actually uses — declining has to reach
    // the public number, not sit behind its cache until it happens to expire
    const declined = await app.inject({
      method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: adminCookie,
      payload: { status: "declined" } as Record<string, unknown>,
    });
    expect(declined.statusCode).toBe(200);
    // otherwise anyone could push the number up with addresses we turn down
    expect((await count()).claimed).toBe(before - 1);
  });

  it("counts an accepted application and the desk it became as one place, not two", async () => {
    const before = (await count()).claimed;
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "first@shop.ca")).limit(1))[0]!;
    await handle.db.insert(schema.tenants).values({ id: "tnt-first", name: "First Shop", plan: "trial" });
    await handle.db.update(schema.enquiries).set({ status: "accepted", tenantId: "tnt-first" }).where(eq(schema.enquiries.id, row.id));
    expect((await count()).claimed).toBe(before);
  });

  it("never reads past the cohort, however many apply", async () => {
    process.env.EARLY_ACCESS_CAP = "2";
    const c = await count();
    expect(c.claimed).toBe(2);
    expect(c.remaining).toBe(0);
    expect(c.full).toBe(true);
    delete process.env.EARLY_ACCESS_CAP;
  });

  it("hands each applicant their real place in line, not a random one", async () => {
    // the card the page prints says "on the record", so the number on it has
    // to mean something — it used to be 38 + random(27)
    const a = (await apply("line-a@shop.ca")).json();
    const b = (await apply("line-b@shop.ca")).json();
    expect(b.charterNo).toBe(a.charterNo + 1);
    expect(a.reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
  });

  it("gives the same person the same number when they apply twice", async () => {
    const first = (await apply("twice@shop.ca")).json();
    const again = (await apply("twice@shop.ca")).json();
    // otherwise re-applying quietly takes a second place in the cohort
    expect(again.charterNo).toBe(first.charterNo);
  });

  it("never hands a declined applicant's number to somebody else", async () => {
    const doomed = (await apply("declined@shop.ca")).json();
    const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, "declined@shop.ca")).limit(1))[0]!;
    await app.inject({
      method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: adminCookie,
      payload: { status: "declined" } as Record<string, unknown>,
    });
    // the place comes back, but the NUMBER does not — a card in somebody's
    // drawer has to keep meaning them
    const next = (await apply("after@shop.ca")).json();
    expect(next.charterNo).toBe(doomed.charterNo + 1);
  });

  it("a contact message is not a claim on a place, so it gets no number", async () => {
    const res = await app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "contact", email: "hello@shop.ca", name: "Someone" } as Record<string, unknown> });
    expect(res.statusCode).toBe(201);
    expect(res.json().charterNo).toBeNull();
  });

  it("says how many, never who", async () => {
    const res = await app.inject({ method: "GET", url: "/api/site/early-access" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("@");
    expect(Object.keys(res.json()).sort()).toEqual(["cap", "claimed", "full", "remaining"]);
  });
});
