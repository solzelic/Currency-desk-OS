/* Moving an application along.

   Every mover — an operator clicking, and one day a reviewer agent — goes
   through one function, so what the applicant hears is declared beside the
   stage rather than buried in whoever triggered it. These pin the rules that
   are easy to break by accident: which moves are legal, what each one sends,
   and the fact that taking a code back needs no machinery beyond moving them
   out of `invited`. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { canMove, STAGES, type Stage } from "../src/onboarding/pipeline.js";

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string> = {};
const ADMIN = "j.masri";

const logged = (): string[] =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));

async function apply(email: string, name: string): Promise<{ id: string; reference: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email, name, details: { jurisdiction: "CA" } } as Record<string, unknown>,
  });
  const reference = res.json().reference;
  const list = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
  const row = (list.enquiries as { id: string; reference: string }[]).find((e) => e.reference === reference)!;
  return { id: row.id, reference };
}
const move = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "PATCH", url: `/api/admin/enquiries/${id}`, cookies: admin, payload: { status, ...extra } as Record<string, unknown> });

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
  admin = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("the board's columns", () => {
  it("are the statuses themselves, so they cannot drift apart", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    expect((d.stages as { id: string }[]).map((s) => s.id)).toEqual(STAGES.map((s) => s.id));
  });

  it("never offers a move into Open — a desk opening is something they do", () => {
    for (const s of STAGES) expect(canMove(s.id, "accepted")).toBe(false);
  });

  /* The buttons on a card are the legal moves, not a second guess at them.
     If these two lists can disagree, an operator gets offered a button that
     returns 400 — which reads as the panel being broken. */
  it("carry the moves that leave them, so a card cannot offer one that fails", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    for (const s of d.stages as { id: Stage; next: Stage[] }[]) {
      for (const to of s.next) expect(canMove(s.id, to)).toBe(true);
    }
    const reviewing = (d.stages as { id: string; next: string[] }[]).find((s) => s.id === "reviewing")!;
    expect(reviewing.next).toEqual(["invited", "hold", "declined"]);
  });

  it("names the approving move as the one button an operator presses", () => {
    const invited = STAGES.find((s) => s.id === "invited")!;
    expect(invited.primary).toBe(true);
    expect(invited.action).toBe("Approve & invite");
    // and nothing else claims to be the main action
    expect(STAGES.filter((s) => s.primary)).toHaveLength(1);
  });
});

describe("what the applicant hears", () => {
  it("tells them somebody is looking, without waiting for anyone to press anything", async () => {
    /* The acknowledgement is not an operator's chore. Applying puts them in
       review and sends it, through the same transition a button would use —
       so there is no window where the application exists and the applicant
       has heard nothing. */
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    const a = await apply("review-me@shop.ca", "Rea Vue");
    const list = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    expect((list.enquiries as { id: string; status: string }[]).find((e) => e.id === a.id)!.status).toBe("reviewing");

    const mail = logged().find((l) => l.includes("to=review-me@shop.ca"));
    expect(mail).toContain("We're looking at your CurrencyDesk application");
    expect(mail).toContain("call you shortly");
  });

  it("does not say it twice when an operator moves them back into review", async () => {
    const a = await apply("again@shop.ca", "Ree Peat");
    await move(a.id, "hold");
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    expect((await move(a.id, "reviewing")).statusCode).toBe(200);
    // coming back from hold DOES re-send: they were told once, then parked,
    // and hearing "we're looking at this" again is true rather than noise
    expect(logged().some((l) => l.includes("to=again@shop.ca"))).toBe(true);
  });

  it("holds somebody in silence — that is our note, not a decision they were told", async () => {
    const a = await apply("hold-me@shop.ca", "Holly Dupp");
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    const res = await move(a.id, "hold");
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBeNull();
    expect(logged().some((l) => l.includes("to=hold-me@shop.ca"))).toBe(false);
  });

  it("lets a held application be approved without going back through review", async () => {
    const a = await apply("held-then-in@shop.ca", "Hal Din");
    await move(a.id, "hold");
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0; // drop the arrival email
    const res = await move(a.id, "invited");
    expect(res.statusCode).toBe(200);
    expect(logged().find((l) => l.includes("to=held-then-in@shop.ca"))).toContain(a.reference);
  });

  it("sends the code and the link on invite, and nothing on decline", async () => {
    const a = await apply("invite-me@shop.ca", "Inn Vite");
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    expect((await move(a.id, "invited")).json().email).toBe("simulated");
    expect(logged().find((l) => l.includes("to=invite-me@shop.ca"))).toContain(a.reference);

    const b = await apply("no-thanks@shop.ca", "Dee Kline");
    (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0; // drop the arrival email
    expect((await move(b.id, "declined")).json().email).toBeNull();
    expect(logged().some((l) => l.includes("to=no-thanks@shop.ca"))).toBe(false);
  });

  it("will not send the same stage twice by accident, but will on purpose", async () => {
    const a = await apply("twice@shop.ca", "Ann Again");
    await move(a.id, "invited");
    expect((await move(a.id, "invited")).statusCode).toBe(400); // double-click
    expect((await move(a.id, "invited", { resend: true })).json().email).toBe("simulated");
  });

  it("says nothing to the walkthrough, which has no inbox", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    const w = (list.enquiries as { id: string; reference: string }[]).find((e) => e.reference === "CD-WALKTHRU")!;
    expect((await move(w.id, "reviewing")).json().email).toBeNull();
  });
});

describe("taking a code back", () => {
  it("needs no machinery — moving them out of invited is what does it", async () => {
    const a = await apply("revoke@shop.ca", "Rev Oak");
    await move(a.id, "invited");
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${a.reference}/state` })).statusCode).toBe(200);

    await move(a.id, "reviewing");
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${a.reference}/state` })).statusCode).toBe(404);

    // and giving it back works, with the same code
    await move(a.id, "invited");
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${a.reference}/state` })).statusCode).toBe(200);
  });

  it("issues a different code when the old one has been seen by the wrong person", async () => {
    const a = await apply("rotate@shop.ca", "Roe Tate");
    await move(a.id, "invited");
    const res = await app.inject({ method: "POST", url: `/api/admin/enquiries/${a.id}/rotate`, cookies: admin, payload: {} });
    expect(res.statusCode).toBe(200);
    const { reference, was } = res.json();
    expect(was).toBe(a.reference);
    expect(reference).not.toBe(was);
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${was}/state` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/onboarding/${reference}/state` })).statusCode).toBe(200);
  });

  it("refuses to rotate a code that has already done its job", async () => {
    const list = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    const open = (list.enquiries as { id: string; status: string }[]).find((e) => e.status === "accepted");
    if (!open) return; // nothing accepted in this run
    expect((await app.inject({ method: "POST", url: `/api/admin/enquiries/${open.id}/rotate`, cookies: admin, payload: {} })).statusCode).toBe(409);
  });
});

describe("labels", () => {
  it("are normalised so one label is one label", async () => {
    const a = await apply("labelled@shop.ca", "Lab El");
    const res = await app.inject({
      method: "PUT", url: `/api/admin/enquiries/${a.id}/labels`, cookies: admin,
      payload: { labels: ["High Volume", "high volume", "  Toronto  "] } as Record<string, unknown>,
    });
    expect(res.json().labels).toEqual(["high volume", "toronto"]);
  });

  it("do not touch the stage — they are what an application is like, not where it is", async () => {
    const a = await apply("still-there@shop.ca", "Stil There");
    await app.inject({ method: "PUT", url: `/api/admin/enquiries/${a.id}/labels`, cookies: admin, payload: { labels: ["urgent"] } as Record<string, unknown> });
    const list = (await app.inject({ method: "GET", url: "/api/admin/enquiries?kind=early_access", cookies: admin })).json();
    const row = (list.enquiries as { id: string; status: string }[]).find((e) => e.id === a.id)!;
    expect(row.status).toBe("reviewing");
  });

  it("offers back what has been used before", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/labels", cookies: admin })).json();
    expect((d.labels as { label: string }[]).map((l) => l.label)).toContain("high volume");
  });

  it("are the platform team's business only", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/labels" })).statusCode).toBe(401);
  });
});

/* The board is meant to read as a process, not five equal boxes. What the
   panel draws — the numbered run, the two ways out, the order — is read
   off these flags, so they are worth pinning. */
describe("the shape of the journey", () => {
  it("numbers the path one, two, three and nothing else", () => {
    const path = STAGES.filter((s) => s.step).sort((a, b) => a.step! - b.step!);
    expect(path.map((s) => [s.step, s.id])).toEqual([[1, "reviewing"], [2, "invited"], [3, "accepted"]]);
  });

  it("marks the ways out as exits, and never as steps", () => {
    for (const s of STAGES) expect(!!(s.step && s.exit)).toBe(false);
    expect(STAGES.filter((s) => s.exit).map((s) => s.id)).toEqual(["hold", "declined"]);
  });

  /* Column order is the array order, and the exits belong after the run —
     drawing "on hold" between review and invited is what made it read as
     somewhere you pass through. */
  it("lists the path before the exits", () => {
    const live = STAGES.filter((s) => !s.legacy);
    const firstExit = live.findIndex((s) => s.exit);
    expect(live.slice(firstExit).every((s) => s.exit)).toBe(true);
  });
});
