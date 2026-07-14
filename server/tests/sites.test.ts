/* Hosted customer sites — task #10. The YorkFX storefront serves at
   /sites/yorkfx/, and once the owner records their domain, any request
   arriving with that Host header serves the same site at the root —
   the DNS handoff needs no code change. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const login = async (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.STATIC_DIR = path.resolve("..");   // repo root holds YorkFX/
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  delete process.env.STATIC_DIR;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("path door: /sites/yorkfx", () => {
  it("serves the homepage at the slug with a trailing slash", async () => {
    const res = await app.inject({ method: "GET", url: "/sites/yorkfx/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("York");
  });

  it("redirects the bare slug into the directory so relative links resolve", async () => {
    const res = await app.inject({ method: "GET", url: "/sites/yorkfx" });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("/sites/yorkfx/");
  });

  it("serves the site's pages and assets under the prefix", async () => {
    const rates = await app.inject({ method: "GET", url: "/sites/yorkfx/YorkFX%20Rates.html" });
    expect(rates.statusCode).toBe(200);
    // pages reference ../yorkfx-converter.js → /sites/yorkfx-converter.js
    const conv = await app.inject({ method: "GET", url: "/sites/yorkfx-converter.js" });
    expect(conv.statusCode).toBe(200);
    expect(conv.headers["content-type"]).toContain("javascript");
  });
});

describe("domain door: DNS handoff", () => {
  it("only an administrator records the domain; it is normalized and audited", async () => {
    const mgr = await login("r.haddad");
    const denied = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(mgr), payload: { siteDomain: "yorkfx.ca" } });
    expect(denied.statusCode).toBe(403);

    const admin = await login("j.masri");
    const bad = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), payload: { siteDomain: "not a domain" } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), payload: { siteDomain: "WWW.YorkFX.ca" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tenant).toMatchObject({ siteSlug: "yorkfx", siteDomain: "yorkfx.ca" });
  });

  it("requests arriving on the customer's domain serve their site at the root", async () => {
    const home = await app.inject({ method: "GET", url: "/", headers: { host: "yorkfx.ca" } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("York");

    // www resolves to the same site; deep paths map into the site directory
    const www = await app.inject({ method: "GET", url: "/YorkFX%20Rates.html", headers: { host: "www.yorkfx.ca" } });
    expect(www.statusCode).toBe(200);

    // the API stays the API on the customer domain — their embedded rate
    // board keeps talking to the same origin
    const api = await app.inject({ method: "GET", url: "/api/health", headers: { host: "yorkfx.ca" } });
    expect(api.statusCode).toBe(200);
    expect(api.json().service).toBe("currencydesk-server");
  });

  it("the CurrencyDesk host itself is untouched — the OS still serves at /", async () => {
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "currencydesk.onrender.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("CurrencyDesk OS");
  });

  it("disconnecting the domain (null) stops the rewrite", async () => {
    const admin = await login("j.masri");
    const off = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), payload: { siteDomain: null } });
    expect(off.statusCode).toBe(200);
    expect(off.json().tenant.siteDomain).toBeNull();
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "yorkfx.ca" } });
    // no mapping → falls through to the default shell, not the storefront
    expect(res.body).toContain("CurrencyDesk OS");
  });
});
