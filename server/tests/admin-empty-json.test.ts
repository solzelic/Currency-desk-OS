/* Remove a team member and delete a desk used to send a JSON content
   type and no body. Fastify refused both before the route ran. The
   admin page now sets that header only when there is a body. An empty
   JSON body must stay a 400, and the same request with no content type
   must reach the route. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const adminHtml = readFileSync(resolve(process.cwd(), "../admin.html"), "utf8");

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie = "";

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
  it("the page sets the header only when a body is present", () => {
    const at = adminHtml.indexOf("const api = async");
    expect(at).toBeGreaterThan(0);
    const fn = adminHtml.slice(at, at + 900);
    expect(fn).toContain("if (init.body != null && init.body !== ''");
    expect(fn).toContain("headers['content-type'] = 'application/json'");
    const guard = fn.indexOf("if (init.body != null && init.body !== ''");
    const header = fn.indexOf("headers['content-type'] = 'application/json'");
    expect(header).toBeGreaterThan(guard);

    expect(adminHtml).toContain("api('/api/admin/team/' + encodeURIComponent(m.email), { method: 'DELETE' })");
    expect(adminHtml).toContain("await api('/api/admin/tenants/' + id, { method: 'DELETE' })");
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
