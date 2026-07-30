/* Running the business from the panel.

   Two surfaces that exist because of things that actually went wrong: a
   storefront served no rates and nobody knew until somebody looked at the
   site, and the emails were written, worked, and were invisible — with
   sending quietly falling back to a log file.

   The drift check at the bottom is the one worth keeping. A stage that
   starts or stops speaking to an applicant must break a test, not surprise
   whoever thought they knew what a button did. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { DISPATCHES, SILENT } from "../src/comms.js";
import { mailStages, STAGES } from "../src/onboarding/pipeline.js";

let handle: DbHandle;
let app: FastifyInstance;
let admin: Record<string, string> = {};
const ADMIN = "j.masri";

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

describe("is anything broken", () => {
  const health = async () => (await app.inject({ method: "GET", url: "/api/admin/health", cookies: admin })).json();

  it("answers every check in a sentence somebody could read out", async () => {
    const d = await health();
    const ids = (d.checks as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(["database", "email", "stripe", "rates", "storefronts"]);
    for (const c of d.checks as { detail: string; state: string }[]) {
      expect(c.detail.length).toBeGreaterThan(10);
      expect(["ok", "warn", "down", "off"]).toContain(c.state);
    }
  });

  /* "Not configured" is a fact, not an outage. A dashboard that shouts
     about unset optional things is one you stop opening. */
  it("calls an unconfigured thing off, not down", async () => {
    const d = await health();
    const email = (d.checks as { id: string; state: string }[]).find((c) => c.id === "email")!;
    expect(email.state).toBe("off");
  });

  it("takes the worst check as the answer rather than averaging to green", async () => {
    const d = await health();
    const worst = (d.checks as { state: string }[]).some((c) => c.state === "down")
      ? "down"
      : (d.checks as { state: string }[]).some((c) => c.state === "warn") ? "warn" : "ok";
    expect(d.state).toBe(worst);
  });

  it("is nobody's business without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/comms" })).statusCode).toBe(401);
  });
});

describe("what we say to people", () => {
  it("says plainly that nothing is being sent when nothing is", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/comms", cookies: admin })).json();
    expect(d.delivery.live).toBe(false);
    expect(d.delivery.fix).toContain("RESEND_API_KEY");
  });

  it("carries a real sample of each one, not a name", async () => {
    const d = (await app.inject({ method: "GET", url: "/api/admin/comms", cookies: admin })).json();
    for (const x of d.dispatches as { id: string; sample: { subject: string; text: string } }[]) {
      expect(x.sample.subject.length).toBeGreaterThan(4);
      expect(x.sample.text.length).toBeGreaterThan(20);
    }
  });

  /* The check that stops the catalogue becoming a lie. */
  it("lists every stage that emails, and claims none that do not", () => {
    const claimed = DISPATCHES.map((d) => d.stage).filter(Boolean).sort();
    expect(claimed).toEqual(mailStages().slice().sort());
  });

  it("writes down the stages that deliberately say nothing", () => {
    const quiet = SILENT.map((s) => s.stage);
    for (const s of quiet) {
      expect(STAGES.some((x) => x.id === s)).toBe(true);   // a real stage
      expect(mailStages()).not.toContain(s);               // that really is silent
    }
    expect(quiet).toContain("hold");
    expect(quiet).toContain("declined");
  });

  it("marks the arrival email automatic and the invitation not", () => {
    expect(DISPATCHES.find((d) => d.id === "review")!.automatic).toBe(true);
    expect(DISPATCHES.find((d) => d.id === "invite")!.automatic).toBe(false);
  });
});
