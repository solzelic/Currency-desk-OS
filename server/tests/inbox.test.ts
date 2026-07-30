/* The inbox.

   A note from the contact page is not an application. It was being served
   through the applications board, so a message asking about EUR support sat
   in a column called In review, offering to Approve & invite it. It is
   answered or it is not, and these pin that model — including the badge,
   which never cleared because nothing moves a contact note through stages. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const ADMIN = "j.masri";

const write = (email: string, details: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "contact", email, name: "Quinn Reyes", details } as Record<string, unknown> });
const inbox = async () =>
  (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=contact", cookies: admin })).json().enquiries as
    { id: string; email: string; handledAt: string | null; details: Record<string, unknown> }[];
const unread = async () =>
  (await app.inject({ method: "GET", url: "/api/admin/overview", cookies: admin })).json().funnel.unread as number;
const mark = (id: string, answered: boolean) =>
  app.inject({ method: "PATCH", url: `/api/admin/enquiries/${id}`, cookies: admin, payload: { answered } as Record<string, unknown> });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("what the contact form sends", () => {
  it("keeps every field the page collects, under the names it uses", async () => {
    expect((await write("quinn@shop.ca", {
      topic: "Early access", shop: "Yorkville Currency", city: "Toronto, Canada",
      message: "Do you support EUR?", newsletter: true,
    })).statusCode).toBe(201);
    const m = (await inbox()).find((x) => x.email === "quinn@shop.ca")!;
    expect(m.details).toMatchObject({
      topic: "Early access", shop: "Yorkville Currency", city: "Toronto, Canada",
      message: "Do you support EUR?", newsletter: true,
    });
  });

  /* A contact message takes no place in the founding cohort. */
  it("does not hand out a charter number", async () => {
    const res = await write("nocharter@shop.ca", { message: "hello" });
    expect(res.json().charterNo).toBeNull();
    expect(res.json().reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
  });
});

describe("answering one", () => {
  it("arrives needing a reply, and the badge says so", async () => {
    const before = await unread();
    await write("needs@shop.ca", { message: "Please call me" });
    expect(await unread()).toBe(before + 1);
    expect((await inbox()).find((m) => m.email === "needs@shop.ca")!.handledAt).toBeNull();
  });

  it("clears the badge when it is answered, and comes back if that was a misclick", async () => {
    const m = (await inbox()).find((x) => x.email === "needs@shop.ca")!;
    const before = await unread();

    expect((await mark(m.id, true)).statusCode).toBe(200);
    expect((await inbox()).find((x) => x.id === m.id)!.handledAt).not.toBeNull();
    expect(await unread()).toBe(before - 1);

    expect((await mark(m.id, false)).statusCode).toBe(200);
    expect((await inbox()).find((x) => x.id === m.id)!.handledAt).toBeNull();
    expect(await unread()).toBe(before);
  });

  it("is on the record, because somebody claimed they replied", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.message_answered");
  });

  it("is the platform team's business only", async () => {
    const m = (await inbox())[0]!;
    expect((await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${m.id}`, payload: { answered: true } as Record<string, unknown> })).statusCode).toBe(401);
  });
});

/* Writing back.

   The point of the inbox is that somebody messages us and we answer them.
   These pin the parts that are easy to get wrong: that sending is what
   marks it answered (a claim you have to remember to make is one that goes
   stale), that the delivery result is kept with the reply, and that a
   reply nobody could receive is refused rather than logged. */
describe("replying from the panel", () => {
  const replyTo = (id: string, body: string) =>
    app.inject({ method: "POST", url: `/api/admin/enquiries/${id}/reply`, cookies: admin, payload: { body } as Record<string, unknown> });
  const thread = async (id: string) =>
    (await app.inject({ method: "GET", url: `/api/admin/enquiries/${id}`, cookies: admin })).json() as
      { enquiry: { handledAt: string | null }; replies: { body: string; emailStatus: string; sentBy: string }[] };

  it("emails them, and keeps the reply with how it went", async () => {
    await write("reply-me@shop.ca", { message: "Do you support EUR?", topic: "Early access" });
    const m = (await inbox()).find((x) => x.email === "reply-me@shop.ca")!;
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;

    const res = await replyTo(m.id, "Yes — EUR is supported, nothing to switch on.");
    expect(res.statusCode).toBe(201);
    // no provider configured in tests, so it is honestly reported as simulated
    expect(res.json().email).toBe("simulated");

    const sent = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0] ?? "")).find((l) => l.includes("to=reply-me@shop.ca"))!;
    expect(sent).toContain("EUR is supported");
    expect(sent).toContain(m.details.topic ? "Re: your note to CurrencyDesk" : "Re:");

    const t = await thread(m.id);
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]!.body).toContain("EUR is supported");
    expect(t.replies[0]!.emailStatus).toBe("simulated");
    expect(t.replies[0]!.sentBy).toBe(ADMIN);
  });

  it("marks it answered by sending, without a second button to remember", async () => {
    const m = (await inbox()).find((x) => x.email === "reply-me@shop.ca")!;
    expect(m.handledAt).not.toBeNull();
  });

  it("keeps the conversation in the order it happened", async () => {
    const m = (await inbox()).find((x) => x.email === "reply-me@shop.ca")!;
    await replyTo(m.id, "One more thing — the float works per currency.");
    const t = await thread(m.id);
    expect(t.replies.map((r) => r.body.slice(0, 8))).toEqual(["Yes — EU", "One more"]);
  });

  it("refuses an empty one rather than sending a blank email", async () => {
    const m = (await inbox()).find((x) => x.email === "reply-me@shop.ca")!;
    expect((await replyTo(m.id, "   ")).statusCode).toBe(400);
  });

  it("will not write to the walkthrough, which has no inbox", async () => {
    const rows = await handle.db.select().from(schema.enquiries);
    const w = rows.find((r) => r.isDemo)!;
    const res = await app.inject({ method: "POST", url: `/api/admin/enquiries/${w.id}/reply`, cookies: admin, payload: { body: "hello" } as Record<string, unknown> });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("is_walkthrough");
  });

  it("is the platform team's business only", async () => {
    const m = (await inbox())[0]!;
    expect((await app.inject({ method: "POST", url: `/api/admin/enquiries/${m.id}/reply`, payload: { body: "hi" } as Record<string, unknown> })).statusCode).toBe(401);
  });
});
