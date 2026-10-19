/* The Employees button runs issueStaffPin. These tests call that
   function. A network throw and a server error message must come back
   as the plain sentence, never the raw text. */
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const { issueStaffPin } = createRequire(import.meta.url)("../../os-src/pin-issue-message.js") as {
  issueStaffPin: (loginId: string, fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) => Promise<{ ok: boolean; err?: string; pin?: string }>;
};

let handle: DbHandle;
let app: FastifyInstance;
let ownerCookie: Record<string, string> = {};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const li = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  const c = li.cookies.find((x) => x.name === "cdos_session");
  ownerCookie = c ? { cdos_session: c.value } : {};
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("Issue a new PIN on the screen", () => {
  it("shows the offline sentence when the request throws", async () => {
    const raw = "ECONNREFUSED 10.9.8.7 socket hang up";
    const out = await issueStaffPin("a.singh", async () => { throw new Error(raw); });
    expect(out.ok).toBe(false);
    expect(out.err).toBe("No connection. The PIN was not issued.");
    expect(JSON.stringify(out)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(out)).not.toContain("10.9.8.7");
    expect(JSON.stringify(out)).not.toContain("socket hang up");
  });

  it("shows the fallback when the server sends its own words", async () => {
    const raw = "Failed query: SELECT pin_hash FROM staff_users";
    const out = await issueStaffPin("a.singh", async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error", message: raw, detail: raw }),
    }));
    expect(out.ok).toBe(false);
    expect(out.err).toBe("The PIN was not issued. Try again.");
    expect(JSON.stringify(out)).not.toContain("Failed query");
    expect(JSON.stringify(out)).not.toContain("pin_hash");
    expect(JSON.stringify(out)).not.toContain("Internal Server Error");
  });

  it("posts {} to the real route and shows only the issued PIN", async () => {
    let sent: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } } | null = null;
    const out = await issueStaffPin("a.singh", async (url, init) => {
      sent = { url, init: init as { method?: string; headers?: Record<string, string>; body?: string } };
      const res = await app.inject({
        method: "POST",
        url,
        headers: init.headers as Record<string, string>,
        payload: init.body as string,
        cookies: ownerCookie,
      });
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.json() };
    });
    expect(sent).toBeTruthy();
    expect(sent!.url).toBe("/api/staff/a.singh/pin");
    expect(sent!.init.method).toBe("POST");
    expect(sent!.init.headers?.["content-type"]).toBe("application/json");
    expect(sent!.init.body).toBe("{}");
    expect(out.ok).toBe(true);
    expect(out.pin).toMatch(/^\d{4}$/);
    expect(out.err).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Bad Request");
  });
});
