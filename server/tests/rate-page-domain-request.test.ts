/* Rates v2.5, Take it further: put the rate page on the shop's own domain.

   For now a person on the team points the domain (the handoff: "manual
   team task for now"). The owner sends the domain and where it was bought;
   it lands in the team's inbox (the admin console's messages, an enquiry
   of kind "contact") and the desk shows it as requested until the owner
   cancels it. One request at a time, the owner's alone (site:publish), and
   each request and cancel is in the audit log. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};
async function login(staffId: string) {
  if (cookies[staffId]) return cookies[staffId]!;
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  return (cookies[staffId] = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value });
}
const as = async (staffId: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, cookies: await login(staffId), ...(payload ? { payload } : {}) });
const URL = "/api/rate-page/domain-request";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });

const contactsFor = async () => (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.kind, "contact")))
  .filter((e) => (e.details as Record<string, unknown> | null)?.tenantId === DEMO.tenantId);

describe("a custom domain for the rate page", () => {
  it("is the owner's: a manager or a stranger cannot ask", async () => {
    expect((await as("r.haddad", "POST", URL, { domain: "yorkfx.ca", registrar: "GoDaddy" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: URL, payload: { domain: "yorkfx.ca", registrar: "GoDaddy" } })).statusCode).toBe(401);
  });

  it("takes a plain domain and a registrar from the list, nothing else", async () => {
    for (const body of [
      { domain: "https://yorkfx.ca", registrar: "GoDaddy" },
      { domain: "york fx.ca", registrar: "GoDaddy" },
      { domain: "yorkfx", registrar: "GoDaddy" },
      { domain: "yorkfx.ca", registrar: "Somewhere" },
      { domain: "yorkfx.ca", registrar: "GoDaddy", extra: 1 },
    ]) expect((await as("j.masri", "POST", URL, body)).statusCode, JSON.stringify(body)).toBe(400);
  });

  it("goes to the team's inbox, shows as requested, and is audited", async () => {
    const res = await as("j.masri", "POST", URL, { domain: "WWW.YorkFX.ca", registrar: "Namecheap" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().domainRequest).toMatchObject({ domain: "yorkfx.ca", registrar: "Namecheap", by: "j.masri" });
    expect((await as("r.haddad", "GET", "/api/rate-page")).json().domainRequest).toMatchObject({ domain: "yorkfx.ca" });
    const inbox = await contactsFor();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.details).toMatchObject({ topic: "Custom domain for the rate page", domain: "yorkfx.ca", registrar: "Namecheap", tenantId: DEMO.tenantId });
    expect(inbox[0]!.reference).toMatch(/^CD-[A-Z0-9]{6}$/);
    const audit = await handle.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "rate_page.domain_requested"), eq(schema.auditEvents.tenantId, DEMO.tenantId)));
    expect(audit).toHaveLength(1);
  });

  it("is one at a time", async () => {
    expect((await as("j.masri", "POST", URL, { domain: "other.ca", registrar: "GoDaddy" })).statusCode).toBe(409);
  });

  it("can be cancelled by the owner; the team's message says so", async () => {
    expect((await as("r.haddad", "DELETE", URL)).statusCode).toBe(403);
    const res = await as("j.masri", "DELETE", URL);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().domainRequest).toBeNull();
    expect((await as("j.masri", "GET", "/api/rate-page")).json().domainRequest).toBeNull();
    expect((await contactsFor())[0]!.notes).toMatch(/^Cancelled by the shop/);
    const audit = await handle.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "rate_page.domain_request_cancelled"), eq(schema.auditEvents.tenantId, DEMO.tenantId)));
    expect(audit).toHaveLength(1);
    expect((await as("j.masri", "POST", URL, { domain: "yorkfx.com", registrar: "Other" })).statusCode).toBe(201);
  });
});
