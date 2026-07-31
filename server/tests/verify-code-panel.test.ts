/* The confirmation code, issued from the panel.

   Setup asks an applicant to confirm their address before the desk is
   built, and normally they press the button on their own screen. On a
   call that is one instruction too many, and while email is not switched
   on it is a dead end — the code goes to a log file nobody can read, so
   nobody can finish setting a desk up, including us testing our own
   product.

   So the panel can issue one. The claim that has to hold, and the only
   reason this is defensible at all, is that it is THE SAME CODE: minted
   through the same storage on the same clock, and accepted by the
   customer's own screen. A second code path that produced something the
   real check rejected would be worse than no button.

   The other half is the disclosure rule. The code comes back to the panel
   ONLY while nothing can be delivered. The moment sending works it goes to
   them and the panel is not told what it was.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const ADMIN = "j.masri";
let id = ""; let reference = "";
const OWNER = "owner@harbour.example";

const issue = () =>
  app.inject({ method: "POST", url: `/api/admin/enquiries/${id}/verify-code`, cookies: admin, payload: {} as Record<string, unknown> });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};

  await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email: "amir@harbour.example", name: "Amir Rostami", details: { jurisdiction: "CA" } } as Record<string, unknown>,
  });
  const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "amir@harbour.example")!;
  id = row.id; reference = row.reference;
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });

describe("before they are approved", () => {
  it("refuses, because there is no setup to confirm yet", async () => {
    const res = await issue();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_invited");
    expect(res.json().detail).toMatch(/Approve them first/);
  });

  it("is the platform team's business only", async () => {
    expect((await app.inject({ method: "POST", url: `/api/admin/enquiries/${id}/verify-code`, payload: {} as Record<string, unknown> })).statusCode).toBe(401);
  });
});

describe("once they are invited", () => {
  beforeAll(async () => {
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${id}`, cookies: admin, payload: { status: "invited" } as Record<string, unknown> });
    // their setup, far enough along to have an owner address on it
    await app.inject({
      method: "PUT", url: `/api/onboarding/${reference}/state`,
      payload: { at: 3, data: { ownerEmail: OWNER, bizName: "Harbour FX Inc." } } as Record<string, unknown>,
    });
  });

  it("goes to the address their setup is working against, not the one they applied with", async () => {
    const res = await issue();
    expect(res.statusCode).toBe(200);
    expect(res.json().sentTo).toBe(OWNER);
    expect(res.json().sentTo).not.toBe("amir@harbour.example");
  });

  /* The whole point. A code the real check would reject is not a
     shortcut, it is a lie told twice. */
  it("is a real code — their own screen accepts it", async () => {
    const code = issue().then((r) => r.json().code);
    const res = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/verify/check`,
      payload: { code: await code } as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(200);
  });

  it("kills the one before it, so “ask for another” is always safe advice", async () => {
    const first = (await issue()).json().code as string;
    const second = (await issue()).json().code as string;
    expect(second).not.toBe(first);

    const stale = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/verify/check`,
      payload: { code: first } as Record<string, unknown>,
    });
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("is on the record — issuing somebody's code is not a quiet act", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.verify_code_issued");
  });
});

/* The disclosure rule, from both sides. */
describe("what the panel is allowed to see", () => {
  it("shows the code while nothing can be delivered, and says so", async () => {
    const body = (await issue()).json();
    expect(body.email).toBe("simulated");
    expect(body.code).toMatch(/^\d{6}$/);
  });

  it("withholds it the moment sending actually works", async () => {
    /* A provider that accepts everything. What matters is the branch, not
       Resend: once delivery succeeds the code has reached them and the
       panel has no business holding a copy. */
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    process.env.RESEND_API_KEY = "re_test"; process.env.EMAIL_FROM = "SAM <sam@mail.example>";
    try {
      const body = (await issue()).json();
      expect(body.email).toBe("sent");
      expect(body.code).toBeNull();
    } finally {
      delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
      fetchSpy.mockRestore();
    }
  });
});

describe("once the desk exists", () => {
  it("has nothing left to confirm", async () => {
    /* Set on the row rather than through the board: Open is reached by
       finishing setup, not by a button, and what is under test here is the
       guard rather than how they got there. */
    await handle.db.update(schema.enquiries).set({ status: "accepted" }).where(eq(schema.enquiries.id, id));
    const res = await issue();
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/already open/);
  });
});
