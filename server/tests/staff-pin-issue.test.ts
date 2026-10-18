/* Issue a new PIN from Settings > Employees.

   The screen posts JSON (`content-type: application/json`) and no body.
   Fastify refuses that before the route runs, and the button shows the
   raw "Bad Request". This is that request. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let ownerCookie: Record<string, string> = {};
let managerCookie: Record<string, string> = {};
let tellerCookie: Record<string, string> = {};

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const signIn = (staffId: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: "yorkville", tenantId: "tnt-yorkfx" },
  });
const staffRow = (staffId: string) =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(1).then((r) => r[0]!);

/* What the Employees screen sends: a JSON content type and an empty body. */
const emptyJson = { headers: { "content-type": "application/json" }, payload: "" as const };

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  ownerCookie = cookieOf(await signIn("j.masri"));
  managerCookie = cookieOf(await signIn("r.haddad"));
  tellerCookie = cookieOf(await signIn("s.iqbal"));
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("issuing a PIN from the Employees screen", () => {
  it("accepts the empty JSON body the Issue a new PIN button sends", async () => {
    const owner = await app.inject({
      method: "POST", url: "/api/staff/a.singh/pin", cookies: ownerCookie, ...emptyJson,
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.body).not.toContain("Bad Request");
    const pin = owner.json().pin as string;
    expect(pin).toMatch(/^\d{4}$/);
    expect(owner.json().mustChange).toBe(true);
    const issued = await staffRow("a.singh");
    expect(issued.pinHash).toBeTruthy();
    expect(issued.pinMustChange).toBe(true);
    const proved = await app.inject({
      method: "POST", url: "/api/staff/pin/verify",
      cookies: cookieOf(await signIn("a.singh")),
      payload: { pin },
    });
    expect(proved.statusCode, proved.body).toBe(200);
    expect(proved.json().mustChange).toBe(true);

    const manager = await app.inject({
      method: "POST", url: "/api/staff/m.costa/pin", cookies: managerCookie, ...emptyJson,
    });
    expect(manager.statusCode, manager.body).toBe(200);
    expect(manager.json().pin).toMatch(/^\d{4}$/);
    expect(manager.json().mustChange).toBe(true);
    expect((await staffRow("m.costa")).pinMustChange).toBe(true);

    /* No payload at all, only the JSON header. That is the same fetch. */
    const headerOnly = await app.inject({
      method: "POST", url: "/api/staff/s.iqbal/pin", cookies: ownerCookie,
      headers: { "content-type": "application/json" },
    });
    expect(headerOnly.statusCode, headerOnly.body).toBe(200);
    expect(headerOnly.body).not.toContain("Bad Request");
    expect((await staffRow("s.iqbal")).pinMustChange).toBe(true);

    const teller = await app.inject({
      method: "POST", url: "/api/staff/a.singh/pin", cookies: tellerCookie, ...emptyJson,
    });
    expect(teller.statusCode, teller.body).toBe(403);
    expect(teller.body).not.toContain("Bad Request");
    expect(teller.json().detail).toBe("Only the owner or a manager can issue a PIN.");

    const self = await app.inject({
      method: "POST", url: "/api/staff/j.masri/pin", cookies: ownerCookie, ...emptyJson,
    });
    expect(self.statusCode, self.body).toBe(403);
    expect(self.body).not.toContain("Bad Request");
    expect(self.json().detail).toBe("Set your own PIN from My account.");

    const above = await app.inject({
      method: "POST", url: "/api/staff/j.masri/pin", cookies: managerCookie, ...emptyJson,
    });
    expect(above.statusCode, above.body).toBe(403);
    expect(above.body).not.toContain("Bad Request");
    expect(above.json().detail).toBe("You can only issue a PIN for someone below your role.");

    /* Setting your own PIN still needs a body. This route is the exception. */
    const own = await app.inject({
      method: "POST", url: "/api/staff/pin", cookies: ownerCookie, ...emptyJson,
    });
    expect(own.statusCode, own.body).toBe(400);
  });
});
