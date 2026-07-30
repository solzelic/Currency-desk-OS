/* Sending one of the written emails to one person, by hand.

   Approving sends the invitation on its own, and the Inbox sends a reply
   somebody typed. Between those two there was nothing: an applicant who
   deleted their invitation, or who wanted the acknowledgement again,
   needed an operator to open their own mail client and rewrite it from
   memory. This is the middle case — pick a template, see what will go,
   send it.

   Three things are worth pinning, and they are all the same worry: an
   email that goes to the wrong person, or carries something that does not
   work, is worse than one that never went.

     · nothing about the recipient is typed — it comes off their record,
       so no request body can readdress an email
     · the preview and the send are one render, so what you approved is
       what leaves
     · a template whose content is a live credential cannot be hand-sent
       at all, because there is no honest way to fake one
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

const apply = (email: string, name: string) =>
  app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email, name, details: { jurisdiction: "CA", workspace: "probe.currencydeskos.com" } } as Record<string, unknown>,
  });
const find = async (email: string) =>
  (await handle.db.select().from(schema.enquiries)).find((e) => e.email === email)!;
const detail = async (id: string) =>
  (await app.inject({ method: "GET", url: `/api/admin/enquiries/${id}`, cookies: admin })).json() as {
    templates: { id: string; action: string | null; blocked: string | null; needs: { id: string }[] }[];
    replies: { body: string; emailStatus: string; sentBy: string }[];
    delivery: { live: boolean };
  };
const post = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/admin/enquiries/${id}/email`, cookies: admin, payload });
const move = (id: string, status: string) =>
  app.inject({ method: "PATCH", url: `/api/admin/enquiries/${id}`, cookies: admin, payload: { status } as Record<string, unknown> });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("the menu on a person's page", () => {
  it("offers every template, and says which cannot go and why", async () => {
    await apply("menu@shop.ca", "Amir Rostami");
    const d = await detail((await find("menu@shop.ca")).id);

    // the whole catalogue is present — a missing row is a worse question
    // for an operator than a disabled one with a reason next to it
    expect(d.templates.map((t) => t.id).sort()).toEqual(DISPATCHES.map((x) => x.id).sort());

    const open = d.templates.filter((t) => t.action && !t.blocked).map((t) => t.id);
    expect(open).toContain("review");
    expect(open).toContain("reply");

    // and every one that cannot go explains itself in a sentence
    for (const t of d.templates.filter((x) => x.blocked)) {
      expect(t.blocked!.length).toBeGreaterThan(20);
    }
  });

  /* The four that carry a live credential. Rendering one of these from a
     box somebody typed into produces a perfect-looking email with a code
     in it that does not work. */
  it("refuses the ones whose content has to be a real credential", async () => {
    const id = (await find("menu@shop.ca")).id;
    for (const t of ["signup_code", "login_code", "cd_id", "temp_password"]) {
      const res = await post(id, { template: t, preview: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("not_sendable_by_hand");
      // and it points at where the real send lives
      expect(String(res.json().detail).length).toBeGreaterThan(20);
    }
  });

  it("will not invent a template that does not exist", async () => {
    const id = (await find("menu@shop.ca")).id;
    expect((await post(id, { template: "refund_apology", preview: true })).statusCode).toBe(404);
  });
});

describe("the preview", () => {
  it("is addressed and filled in from their record, not from the request", async () => {
    const id = (await find("menu@shop.ca")).id;
    const res = await post(id, { template: "review", preview: true });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.preview).toBe(true);
    expect(p.to).toBe("menu@shop.ca");
    expect(p.text).toContain("Amir Rostami");
    expect(p.subject).toBeTruthy();
  });

  /* The whole reason preview is a flag on the send rather than a route of
     its own: one renderer, so the two cannot drift apart. */
  it("is the same words that are sent a moment later", async () => {
    const id = (await find("menu@shop.ca")).id;
    const shown = (await post(id, { template: "review", preview: true })).json();
    clearLog();
    const sent = await post(id, { template: "review" });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().subject).toBe(shown.subject);

    const line = logged().find((l) => l.includes("to=menu@shop.ca"))!;
    expect(line).toContain(shown.subject);
    // the body too, not just the subject
    expect(line).toContain(shown.text.split("\n")[0]);
  });

  it("does not send anything, or leave a mark", async () => {
    await apply("quiet@shop.ca", "Nadia Haddad");
    const id = (await find("quiet@shop.ca")).id;
    clearLog();
    expect((await post(id, { template: "review", preview: true })).statusCode).toBe(200);
    expect(logged().some((l) => l.includes("to=quiet@shop.ca"))).toBe(false);
    expect((await detail(id)).replies).toHaveLength(0);
  });
});

describe("sending it", () => {
  it("writes what was actually said onto their thread, with how it went", async () => {
    const id = (await find("quiet@shop.ca")).id;
    expect((await post(id, { template: "review" })).statusCode).toBe(201);

    const t = (await detail(id)).replies;
    expect(t).toHaveLength(1);
    // the words, not the name of a template — "review" tells nobody anything in a year
    expect(t[0]!.body).toContain("Nadia Haddad");
    expect(t[0]!.emailStatus).toBe("simulated");
    expect(t[0]!.sentBy).toBe(ADMIN);
  });

  it("is on the record", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.enquiry_emailed");
  });

  it("refuses one whose only content is a field left empty", async () => {
    const id = (await find("quiet@shop.ca")).id;
    const res = await post(id, { template: "reply", fields: { body: "   " } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_field");
  });

  it("sends what an operator wrote, signed by them", async () => {
    const id = (await find("quiet@shop.ca")).id;
    clearLog();
    expect((await post(id, { template: "reply", fields: { body: "EUR settles same day." } })).statusCode).toBe(201);
    const line = logged().find((l) => l.includes("to=quiet@shop.ca"))!;
    expect(line).toContain("EUR settles same day.");
  });

  it("will not write to the walkthrough, which has no inbox", async () => {
    const w = (await handle.db.select().from(schema.enquiries)).find((r) => r.isDemo)!;
    const res = await post(w.id, { template: "review" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("is_walkthrough");
  });

  it("is the platform team's business only", async () => {
    const id = (await find("quiet@shop.ca")).id;
    const res = await app.inject({ method: "POST", url: `/api/admin/enquiries/${id}/email`, payload: { template: "review" } as Record<string, unknown> });
    expect(res.statusCode).toBe(401);
  });
});

/* The invitation is the one with a guard on it, because the link inside
   only opens while they are Invited. Sending it to anybody else hands
   them a dead door and a reason to ring up. */
describe("the invitation, which only works while it works", () => {
  it("is refused before they are approved, in words rather than a code", async () => {
    await apply("early@shop.ca", "Priya Anand");
    const id = (await find("early@shop.ca")).id;

    const listed = (await detail(id)).templates.find((t) => t.id === "invite")!;
    expect(listed.blocked).toMatch(/Invited/);

    const res = await post(id, { template: "invite", preview: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("blocked");
  });

  /* The greyed-out button in the panel and the refusal from the server
     are the same function, so they cannot disagree. */
  it("opens up the moment they are, and carries their real reference", async () => {
    const row = await find("early@shop.ca");
    expect((await move(row.id, "invited")).statusCode).toBe(200);

    expect((await detail(row.id)).templates.find((t) => t.id === "invite")!.blocked).toBeNull();
    const p = (await post(row.id, { template: "invite", preview: true })).json();
    expect(p.text).toContain(row.reference);
    expect(p.text).toContain("/onboarding/" + row.reference);
  });
});
