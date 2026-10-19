/* Remove a team member and delete a desk used to send a JSON content
   type and no body. Fastify refused both before the route ran. The
   compiled admin page is loaded here and its api() is called, the same
   function the buttons use. An empty JSON body must stay a 400, and the
   same request with no content type must reach the route. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie = "";

type Sent = { path: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const li = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  adminCookie = li.cookies.find((c) => c.name === "cdos_session")?.value ?? "";
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("admin deletes omit a JSON content type when there is no body", () => {
  it("the compiled page sends no content type on delete, and JSON when there is a body", async () => {
    const sent: Sent[] = [];
    const src = readFileSync(resolve(process.cwd(), "../web/app/admin.js"), "utf8")
      .replace("const api =", "globalThis.api =");
    const sandbox: Record<string, unknown> = {
      console,
      setTimeout,
      clearTimeout,
      React: {
        useState: (v: unknown) => [v, () => {}],
        useEffect: () => {},
        useMemo: (fn: () => unknown) => fn(),
        useRef: () => ({ current: null }),
      },
      ReactDOM: { createRoot: () => ({ render: () => {} }) },
      document: { getElementById: () => ({}) },
      location: { hash: "", href: "http://desk/admin" },
      window: {},
      fetch: async (path: string, init: Sent["init"]) => {
        sent.push({ path, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    };
    sandbox.globalThis = sandbox;
    try {
      vm.runInNewContext(src, sandbox, { filename: "admin.js" });
    } catch (err) {
      if (typeof sandbox.api !== "function") throw err;
    }
    const api = sandbox.api as (path: string, opts?: { method?: string; body?: string }) => Promise<unknown>;
    await api("/api/admin/team/" + encodeURIComponent("m@example.com"), { method: "DELETE" });
    await api("/api/admin/tenants/tnt-yorkfx", { method: "DELETE" });
    await api("/api/admin/team", { method: "POST", body: JSON.stringify({ email: "m@example.com", role: "support" }) });

    expect(sent[0]?.path).toBe("/api/admin/team/m%40example.com");
    expect(sent[0]?.init.method).toBe("DELETE");
    expect(sent[0]?.init.body).toBeUndefined();
    expect(sent[0]?.init.headers?.["content-type"]).toBeUndefined();
    expect(sent[1]?.init.method).toBe("DELETE");
    expect(sent[1]?.init.body).toBeUndefined();
    expect(sent[1]?.init.headers?.["content-type"]).toBeUndefined();
    expect(sent[2]?.init.headers?.["content-type"]).toBe("application/json");
    expect(sent[2]?.init.body).toContain("m@example.com");
  });

  it("an empty JSON body is refused, and no content type reaches the route", async () => {
    const empty = { headers: { "content-type": "application/json", cookie: `cdos_session=${adminCookie}` }, payload: "" };
    const teamEmpty = await app.inject({ method: "DELETE", url: "/api/admin/team/nobody@example.com", ...empty });
    expect(teamEmpty.statusCode, teamEmpty.body).toBe(400);
    expect(teamEmpty.body).toContain("Body cannot be empty");

    const deskEmpty = await app.inject({ method: "DELETE", url: "/api/admin/tenants/tnt-yorkfx", ...empty });
    expect(deskEmpty.statusCode, deskEmpty.body).toBe(400);
    expect(deskEmpty.body).toContain("Body cannot be empty");

    const team = await app.inject({
      method: "DELETE",
      url: "/api/admin/team/nobody@example.com",
      headers: { cookie: `cdos_session=${adminCookie}` },
    });
    expect(team.statusCode, team.body).toBe(404);

    const desk = await app.inject({
      method: "DELETE",
      url: "/api/admin/tenants/tnt-yorkfx",
      headers: { cookie: `cdos_session=${adminCookie}` },
    });
    expect(desk.statusCode, desk.body).toBe(409);
    expect(desk.json().error).toBe("not_suspended");
  });
});
