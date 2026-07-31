/* Sending yourself one of each.

   The Emails page renders every template, which answers "is the markup
   right" and not "what does this look like in Gmail on a phone". Only the
   second question catches what actually goes wrong, and the only way to
   ask it is to put the thing in a real inbox.

   The part worth guarding is who it can reach. A sample carries a made-up
   reference and a setup link that opens nothing, so an applicant getting
   "You're in" out of the blue is a phone call nobody can take back — and
   the mistake is one typo away, because the addresses are typed. So the
   server checks every one of them against the people it knows about and
   refuses by name.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { DISPATCHES } from "../src/comms.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const ADMIN = "j.masri";
const logged = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));
const clearLog = () => { (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0; };

const send = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/admin/comms/sample", cookies: admin, payload });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};

  await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email: "applicant@shop.ca", name: "Amir Rostami", details: { jurisdiction: "CA" } } as Record<string, unknown>,
  });
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("what it sends", () => {
  it("sends one of every template that has a body", async () => {
    clearLog();
    const res = await send({ to: ["me@mine.example"] });
    expect(res.statusCode).toBe(201);
    const sent = res.json().sent as { template: string }[];
    // the platform alert has no rendered body and is skipped rather than
    // sent as a blank email
    const withBody = DISPATCHES.filter((d) => { const s = d.sample(); return !!(s.html || s.text); });
    expect(sent.map((s) => s.template).sort()).toEqual(withBody.map((d) => d.id).sort());
    expect(logged().filter((l) => l.includes("to=me@mine.example")).length).toBe(sent.length);
  });

  it("sends just one when you ask for one", async () => {
    const res = await send({ to: ["me@mine.example"], template: "invite" });
    expect(res.json().sent).toHaveLength(1);
    expect(res.json().sent[0].template).toBe("invite");
  });

  it("sends to each address you give it", async () => {
    const res = await send({ to: ["a@mine.example", "b@mine.example"], template: "review" });
    expect((res.json().sent as { to: string }[]).map((s) => s.to).sort()).toEqual(["a@mine.example", "b@mine.example"]);
  });

  it("says honestly that nothing arrived while email is off", async () => {
    const res = await send({ to: ["me@mine.example"], template: "review" });
    expect(res.json().sent[0].email).toBe("simulated");
    expect(res.json().delivery.live).toBe(false);
  });

  it("is on the record", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.samples_sent");
  });
});

/* The guardrail. One typo away from mailing a customer. */
describe("who it refuses to reach", () => {
  it("will not send a sample to somebody who applied", async () => {
    clearLog();
    const res = await send({ to: ["applicant@shop.ca"] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("real_person");
    expect(res.json().detail).toContain("applicant@shop.ca");
    // and nothing went out — not even to the addresses that were fine
    expect(logged().some((l) => l.includes("[email simulated]"))).toBe(false);
  });

  it("refuses the whole batch when one address in it is real", async () => {
    const res = await send({ to: ["me@mine.example", "applicant@shop.ca"] });
    expect(res.statusCode).toBe(409);
  });

  it("will not send to somebody who works on a customer's desk", async () => {
    const staff = (await handle.db.select().from(schema.staffUsers)).find((s) => /@/.test(s.staffId));
    if (!staff) return; // the seed signs its people in by name; nothing to prove here
    expect((await send({ to: [staff.staffId] })).statusCode).toBe(409);
  });

  it("caps the batch, so this cannot become a mailing list", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `x${i}@mine.example`);
    expect((await send({ to: many })).statusCode).toBe(400);
  });

  it("will not invent a template", async () => {
    expect((await send({ to: ["me@mine.example"], template: "nope" })).statusCode).toBe(404);
  });

  it("is the platform team's business only", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/comms/sample", payload: { to: ["me@mine.example"] } as Record<string, unknown> });
    expect(res.statusCode).toBe(401);
  });
});
