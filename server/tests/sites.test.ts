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

  it("the CurrencyDesk host itself serves the public site at / and the OS at /app", async () => {
    const site = await app.inject({ method: "GET", url: "/", headers: { host: "currencydesk.onrender.com" } });
    expect(site.statusCode).toBe(200);
    expect(site.body).toContain("more trades, less paperwork");

    const os = await app.inject({ method: "GET", url: "/app", headers: { host: "currencydesk.onrender.com" } });
    expect(os.statusCode).toBe(200);
    expect(os.body).toContain("CurrencyDesk OS");

    // deep links collapse onto /app so the OS's root-relative assets resolve
    const deep = await app.inject({ method: "GET", url: "/app/anything", headers: { host: "currencydesk.onrender.com" } });
    expect(deep.statusCode).toBe(301);
    expect(deep.headers.location).toBe("/app");
  });
});

/* The marketing site is two designs — a desktop page with no mobile
   breakpoints and a phone page that is its own document — plus the two
   doors into the product. */
describe("the public site", () => {
  const canonical = (body: string) => /rel="canonical" href="[^"]*?([^/"]*)"/.exec(body)?.[1] ?? "";

  it("keeps repository, server, and Git files outside the public static boundary", async () => {
    const attempts = [
      "/package.json",
      "/render.yaml",
      "/server/package.json",
      "/server/src/auth/sessions.ts",
      "/server/.env",
      "/.git/HEAD",
    ];

    for (const url of attempts) {
      const res = await app.inject({ method: "GET", url });
      expect(res.payload).not.toContain("currencydesk-server");
      expect(res.payload).not.toContain("opaque random tokens in an httpOnly cookie");
      expect(res.payload).not.toContain("Render blueprint");
      expect(res.payload).not.toMatch(/^ref: /m);
    }
  });

  it("gives a phone the phone design and everyone else the desktop one", async () => {
    const phone = await app.inject({
      method: "GET", url: "/",
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1" },
    });
    expect(phone.statusCode).toBe(200);
    expect(canonical(phone.body)).toBe("m");

    const laptop = await app.inject({
      method: "GET", url: "/",
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36" },
    });
    expect(canonical(laptop.body)).toBe("");

    // a cache in front of us must not hand one audience the other's layout
    expect(phone.headers.vary).toBe("User-Agent");
  });

  it("addresses each layout directly, so a wrong guess is correctable", async () => {
    expect(canonical((await app.inject({ method: "GET", url: "/m" })).body)).toBe("m");
    expect(canonical((await app.inject({ method: "GET", url: "/d" })).body)).toBe("");
  });

  it("serves every page the design has delivered", async () => {
    const pages: [string, string][] = [
      ["/legal", "Privacy Policy and Terms of Service"],
      ["/faq", "Everything a shop asks before it switches"],
      ["/contact", "Talk to the people building it"],
      ["/compliance", "Compliance"],
    ];
    for (const [url, expected] of pages) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(expected);
    }
  });

  it("falls back to the front page for a design we do not have yet", async () => {
    // no Add-ons page — its links point at #pricing on the front page, and
    // the route stays unclaimed rather than 200-ing an empty shell
    const res = await app.inject({ method: "GET", url: "/add-ons" });
    expect(res.body).toContain("more trades, less paperwork");
  });

  it("sends applicants to the design's Early Access page and members to the OS", async () => {
    const apply = await app.inject({ method: "GET", url: "/signup" });
    expect(apply.statusCode).toBe(200);
    expect(apply.body).toContain("Become a Founding Operator");

    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("CurrencyDesk OS");

    // an accepted operator still creates their desk from the OS's own wizard
    const wizard = await app.inject({ method: "GET", url: "/app?signup=1" });
    expect(wizard.statusCode).toBe(200);
    expect(wizard.body).toContain("CurrencyDesk OS");
  });

  it("leaves no link pointing at a design file", async () => {
    for (const url of ["/", "/m", "/legal", "/faq", "/contact", "/compliance", "/signup"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, url).not.toContain(".dc.html");
    }
  });

  it("disconnecting the domain (null) stops the rewrite", async () => {
    const admin = await login("j.masri");
    const off = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), payload: { siteDomain: null } });
    expect(off.statusCode).toBe(200);
    expect(off.json().tenant.siteDomain).toBeNull();
    const res = await app.inject({ method: "GET", url: "/", headers: { host: "yorkfx.ca" } });
    // no mapping → falls through to the CurrencyDesk front door, not the storefront
    expect(res.body).toContain("more trades, less paperwork");
  });
});
