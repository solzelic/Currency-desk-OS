/* Public storefront APIs — task #11. Contact/hours published from the OS
   hydrate the hosted site, and "Get a live quote" becomes an SMS rate
   hold priced off the same published board the desk runs on. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { clientIp } from "../src/auth/client-ip.js";
import { clearRateBuckets, rateBucketKeys } from "../src/routes/public-site.js";
import { moneyFixed, priceStorefrontHold } from "../src/sites/storefront-hold.js";

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
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("published site config", () => {
  it("a manager publishes contact + hours; the public endpoint serves them", async () => {
    const mgr = await login("r.haddad");
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/tenant",
      cookies: cookieOf(mgr),
      payload: { siteConfig: { phone: "647-349-0980", email: "desk@yorkfx.ca", address: "69 Yorkville Ave, Unit 102", city: "Toronto", region: "ON", postal: "M5R 1B8", hours: [{ days: "Mon–Fri", hours: "9:30am–6:00pm" }, { days: "Sat–Sun & holidays", hours: "10:00am–5:00pm" }] } },
    });
    expect(patch.statusCode).toBe(200);

    const pub = await app.inject({ method: "GET", url: "/api/sites/yorkfx/config" });
    expect(pub.statusCode).toBe(200);
    const site = pub.json().site;
    expect(site).toMatchObject({ name: "York FX", slug: "yorkfx", phone: "647-349-0980" });
    expect(site.hours).toHaveLength(2);

    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("tenant.site_config_changed");
  });

  it("a teller cannot publish site config; browser users cannot change a paid plan directly", async () => {
    const teller = await login("m.costa");
    const denied = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(teller), payload: { siteConfig: { phone: "555" } } });
    expect(denied.statusCode).toBe(403);
    const mgr = await login("r.haddad");
    const deniedPlan = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(mgr), payload: { plan: "basic" } });
    expect(deniedPlan.statusCode).toBe(400);
  });
});

describe("SMS rate holds", () => {
  it("prices a quote off the published board, holds 30 min, and composes the text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/yorkfx/quotes",
      payload: { phone: "647 555 0134", from: "CAD", to: "USD", amount: 1000 },
    });
    expect(res.statusCode).toBe(201);
    const q = res.json().quote;
    expect(Object.keys(q).sort()).toEqual(["amount", "expiresAt", "from", "receive", "ref", "status", "to"]);
    expect(q.status).toBe("held");
    expect(q.expiresAt).toBeGreaterThan(Date.now() + 25 * 60 * 1000);

    // desk math: selling USD at mid*(1+sellMargin) — seed board USD mid & 1.5%
    const board = (await handle.db.select().from(schema.rateBoards))[0]!;
    const expected = priceStorefrontHold({
      from: "CAD",
      to: "USD",
      amount: "1000",
      board: {
        buyMargin: board.buyMargin,
        sellMargin: board.sellMargin,
        rows: board.boardRows,
      },
    });
    expect(q.receive).toBe(Number(expected.receiveAmount.toFixed(2)));
    expect(q.amount).toBe(1000);

    const row = (await handle.db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, q.ref)))[0]!;
    expect(row.phone).toBe("+16475550134");
    expect(row.smsStatus).toBe("simulated");
    expect(row.smsText).toContain(q.ref);
    expect(row.smsText).toContain("held for 30 min");
    expect(row.smsText).toContain("Reply STOP to opt out");
    /* Persisted as numeric strings, not IEEE floats — the 2dp the SMS showed. */
    expect(row.haveAmount).toBe("1000.00");
    expect(row.receiveAmount).toBe(moneyFixed(expected.receiveAmount));
    expect(row.quotedRate).toBe(expected.quotedRate.toDecimalPlaces(12).toFixed(12));
  });

  it("persists a hold the ledger can reproduce from stored amounts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/yorkfx/quotes",
      payload: { phone: "647 555 0144", from: "CAD", to: "USD", amount: 10 },
    });
    expect(res.statusCode).toBe(201);
    const row = (await handle.db.select().from(schema.rateQuotes).where(eq(schema.rateQuotes.id, res.json().quote.ref)))[0]!;
    expect(new Decimal(row.quotedRate).mul(row.haveAmount).toDecimalPlaces(2).toFixed(2)).toBe(row.receiveAmount);
  });

  it("confirming a held quote flips it and refuses after expiry", async () => {
    const make = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550177", from: "USD", to: "CAD", amount: 500 } });
    const ref = make.json().quote.ref;
    const ok = await app.inject({ method: "POST", url: `/api/sites/yorkfx/quotes/${ref}/confirm` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().quote.status).toBe("confirmed");

    // force expiry and check both confirm and read-side status
    const make2 = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550178", from: "CAD", to: "EUR", amount: 200 } });
    const ref2 = make2.json().quote.ref;
    await handle.db.update(schema.rateQuotes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.rateQuotes.id, ref2));
    const late = await app.inject({ method: "POST", url: `/api/sites/yorkfx/quotes/${ref2}/confirm` });
    expect(late.statusCode).toBe(410);
  });

  it("brakes abuse: a phone gets three quotes an hour", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550199", from: "CAD", to: "USD", amount: 100 + i } });
      expect(r.statusCode).toBe(201);
    }
    const fourth = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550199", from: "CAD", to: "USD", amount: 999 } });
    expect(fourth.statusCode).toBe(429);
  });

  it("rejects numbers we cannot text and unknown currencies", async () => {
    const badPhone = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "12", from: "CAD", to: "USD", amount: 100 } });
    expect(badPhone.statusCode).toBe(400);
    const badCcy = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", payload: { phone: "6475550111", from: "CAD", to: "XXX", amount: 100 } });
    expect(badCcy.statusCode).toBe(400);
  });

  it("staff see the desk's incoming holds", async () => {
    const teller = await login("m.costa");
    const res = await app.inject({ method: "GET", url: "/api/quotes", cookies: cookieOf(teller) });
    expect(res.statusCode).toBe(200);
    expect(res.json().quotes.length).toBeGreaterThanOrEqual(5);
    const unauth = await app.inject({ method: "GET", url: "/api/quotes" });
    expect(unauth.statusCode).toBe(401);
  });
});

/* A stranger who can guess Q- plus four digits must not learn who asked,
   and must not be able to confirm the whole board in one burst. */
const CONFIRM_MAX = 30;

const confirm = (
  slug: string,
  ref: string,
  remoteAddress: string,
  headers?: Record<string, string>,
) => app.inject({
  method: "POST",
  url: `/api/sites/${slug}/quotes/${ref}/confirm`,
  remoteAddress,
  headers,
});

describe("public site responses do not carry a customer's phone or name", () => {
  it("no public /api/sites or /api/site response contains that phone or name", async () => {
    const phone = "5875550142";
    const name = "Lioramek Voss";
    const normalized = "+15875550142";
    const created = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", remoteAddress: "203.0.113.15", payload: { phone, name, from: "CAD", to: "USD", amount: 40 } });
    expect(created.statusCode).toBe(201);
    expect(Object.keys(created.json().quote).sort()).toEqual(["amount", "expiresAt", "from", "receive", "ref", "status", "to"]);
    const ref = created.json().quote.ref as string;

    const admin = await login("j.masri");
    const domain = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), remoteAddress: "203.0.113.15", payload: { siteDomain: "quotes-leak.example" } });
    expect(domain.statusCode).toBe(200);

    const calls: { url: string; run: Promise<{ statusCode: number; body: string; json: () => unknown }> }[] = [
      { url: "/api/sites/yorkfx/quotes", run: Promise.resolve(created) },
      { url: `/api/sites/yorkfx/quotes/${ref}/confirm`, run: confirm("yorkfx", ref, "203.0.113.16") },
      { url: "/api/sites/yorkfx/quotes/Q-9999/confirm", run: confirm("yorkfx", "Q-9999", "203.0.113.17") },
      { url: "/api/sites/yorkfx/config", run: app.inject({ method: "GET", url: "/api/sites/yorkfx/config" }) },
      { url: "/api/sites/yorkfx/rates", run: app.inject({ method: "GET", url: "/api/sites/yorkfx/rates" }) },
      { url: "/api/sites/no-such-shop/config", run: app.inject({ method: "GET", url: "/api/sites/no-such-shop/config" }) },
      { url: "/api/sites/no-such-shop/rates", run: app.inject({ method: "GET", url: "/api/sites/no-such-shop/rates" }) },
      { url: "/api/site/config", run: app.inject({ method: "GET", url: "/api/site/config", headers: { host: "quotes-leak.example" } }) },
      { url: "/api/site/rates", run: app.inject({ method: "GET", url: "/api/site/rates", headers: { host: "quotes-leak.example" } }) },
      { url: "/api/site/config", run: app.inject({ method: "GET", url: "/api/site/config" }) },
      { url: "/api/site/rates", run: app.inject({ method: "GET", url: "/api/site/rates" }) },
      { url: "/api/site/early-access", run: app.inject({ method: "GET", url: "/api/site/early-access" }) },
    ];
    const responses = await Promise.all(calls.map(async (call) => {
      const res = await call.run;
      return { url: call.url, statusCode: res.statusCode, body: res.body, json: () => res.json() };
    }));

    for (const res of responses) for (const bit of [name, "Lioramek", "Voss", normalized, phone]) expect(res.body).not.toContain(bit);

    const confirmed = responses[1]!.json() as { quote: Record<string, unknown> };
    expect(responses[1]!.statusCode).toBe(200);
    expect(confirmed.quote).toEqual({ ref, status: "confirmed", expiresAt: expect.any(Number) });
    expect(Object.keys(confirmed.quote).sort()).toEqual(["expiresAt", "ref", "status"]);

    const allow = {
      create: ["quote", "ref", "status", "expiresAt", "from", "to", "amount", "receive"],
      confirm: ["quote", "ref", "status", "expiresAt"],
      config: ["site", "name", "slug", "phone", "email", "address", "city", "region", "postal", "hours", "days", "updatedAt"],
      rates: ["published", "publishedAt", "currencies", "rates", "code", "buy", "sell", "board", "buyMargin", "sellMargin", "rows", "order", "mid", "spread", "show"],
      early: ["claimed", "cap", "remaining", "full"],
      error: ["error"],
    };
    const shape = (url: string, status: number) => {
      if (status >= 400) return allow.error;
      if (url.endsWith("/quotes")) return allow.create;
      if (url.includes("/confirm")) return allow.confirm;
      if (url.endsWith("/config")) return allow.config;
      if (url.endsWith("/rates")) return allow.rates;
      return allow.early;
    };
    /* `board.rows` is a map keyed by currency code. Those codes are data,
       so they are not fields. The row objects under them still are. */
    const keys = (value: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) { for (const item of value) keys(item, out); return out; }
      if (!value || typeof value !== "object") return out;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out.add(key);
        if (key === "rows" && child && typeof child === "object" && !Array.isArray(child)) {
          for (const row of Object.values(child as Record<string, unknown>)) keys(row, out);
        } else {
          keys(child, out);
        }
      }
      return out;
    };
    for (const res of responses) {
      const extra = [...keys(res.json())].filter((key) => !shape(res.url, res.statusCode).includes(key));
      expect(extra, res.url).toEqual([]);
    }
  });
});

describe("confirm rate limit", () => {
  it("limits confirm to 30 a minute for one slug, with the same body for every ref", async () => {
    const phone = "5875550143";
    const name = "Sluglimit Probe";
    const created = await app.inject({ method: "POST", url: "/api/sites/yorkfx/quotes", remoteAddress: "203.0.113.50", payload: { phone, name, from: "CAD", to: "USD", amount: 25 } });
    expect(created.statusCode).toBe(201);
    const ref = created.json().quote.ref as string;
    clearRateBuckets();
    const slug = "yorkfx";

    for (let n = 1; n <= CONFIRM_MAX; n++) {
      const res = await confirm(slug, "Q-1000", `192.0.2.${n}`);
      expect(res.statusCode, `confirm ${n}`).toBe(404);
    }
    const missing = await confirm(slug, "Q-1000", "192.0.2.40");
    const real = await confirm(slug, ref, "192.0.2.41");
    expect(missing.statusCode).toBe(429);
    expect(real.statusCode).toBe(429);
    expect(real.body).toBe(missing.body);
    expect(missing.json()).toEqual({ error: "slow_down", detail: "Too many tries. Wait a minute and try again." });
    for (const body of [missing.body, real.body]) {
      expect(body).not.toContain(phone);
      expect(body).not.toContain(name);
    }
    expect(real.body).not.toContain(ref);
  });

  it("gives two client addresses separate limits, through clientIp", async () => {
    const first = "198.51.100.10";
    const second = "198.51.100.11";
    expect(clientIp({ ip: first, headers: {} })).toBe(first);
    expect(clientIp({ ip: second, headers: {} })).toBe(second);

    for (let n = 1; n <= CONFIRM_MAX; n++) {
      const res = await confirm("ip-limit-a", "Q-2000", first);
      expect(res.statusCode, `first ${n}`).toBe(404);
    }
    const blocked = await confirm("ip-limit-b", "Q-2000", first);
    const open = await confirm("ip-limit-b", "Q-2000", second);
    expect(blocked.statusCode).toBe(429);
    expect(open.statusCode).toBe(404);
  });

  it("ignores a spoofed CF-Connecting-IP from a non-Cloudflare hop, through clientIp", async () => {
    const socket = "203.0.113.80";
    const other = "203.0.113.81";
    const headersFor = (n: number) => ({ "cf-connecting-ip": `198.51.100.${n}` });
    expect(clientIp({ ip: socket, headers: headersFor(1) })).toBe(socket);
    expect(clientIp({ ip: socket, headers: headersFor(1) })).not.toBe("198.51.100.1");

    for (let n = 1; n <= CONFIRM_MAX; n++) {
      const res = await confirm(`spoof-${n}`, "Q-3000", socket, headersFor(n));
      expect(res.statusCode, `spoof ${n}`).toBe(404);
    }
    const blocked = await confirm("spoof-extra", "Q-3001", socket, { "cf-connecting-ip": "198.51.100.200" });
    const separate = await confirm("spoof-other", "Q-3002", other, { "cf-connecting-ip": "198.51.100.200" });
    expect(blocked.statusCode).toBe(429);
    expect(separate.statusCode).toBe(404);
    expect(clientIp({ ip: other, headers: { "cf-connecting-ip": "198.51.100.200" } })).toBe(other);
  });

  it("does not rate limit a slug that is not a real site", async () => {
    for (let n = 1; n <= 40; n++) {
      const res = await confirm("ghost-slug", "Q-1", `203.0.113.${100 + n}`);
      expect(res.statusCode, `ghost ${n}`).toBe(404);
    }
  });

  it("returns a plain error when the client address is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sites/yorkfx/quotes/Q-4040/confirm",
      remoteAddress: " ",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("Sign-in");
    expect(res.body).not.toContain("client address");
    expect(res.json()).toEqual({ error: "invalid_request", detail: "Try again in a bit, or call the desk." });
  });

  it("drops a bucket once its window has passed", async () => {
    clearRateBuckets();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
      expect((await confirm("ghost-old", "Q-1", "203.0.113.180")).statusCode).toBe(404);
      expect(rateBucketKeys()).toContain("confirm-ip:203.0.113.180");
      expect(rateBucketKeys().some((key) => key.startsWith("confirm-slug:"))).toBe(false);
      vi.setSystemTime(new Date("2026-10-19T12:01:01Z"));
      expect((await confirm("yorkfx", "Q-2", "203.0.113.181")).statusCode).toBe(404);
      /* Cleanup runs at most once a minute. 61s is past both the window and that pause. */
      expect(rateBucketKeys()).not.toContain("confirm-ip:203.0.113.180");
      expect(rateBucketKeys()).toContain("confirm-ip:203.0.113.181");
    } finally {
      vi.useRealTimers();
    }
  });

  it("texts only the first confirm", async () => {
    clearRateBuckets();
    const created = await app.inject({
      method: "POST",
      url: "/api/sites/yorkfx/quotes",
      remoteAddress: "203.0.113.70",
      payload: { phone: "5875550191", from: "CAD", to: "USD", amount: 30 },
    });
    expect(created.statusCode).toBe(201);
    const ref = created.json().quote.ref as string;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    try {
      const first = await confirm("yorkfx", ref, "203.0.113.71");
      const second = await confirm("yorkfx", ref, "203.0.113.72");
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(logs.filter((line) => line.includes("confirmed") && line.includes(ref))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
