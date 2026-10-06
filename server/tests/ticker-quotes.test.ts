/* An RSD desk's tape is dinars per unit, never Canadian dollars per unit.
   USD 1.36 CAD and RSD 0.0125 CAD is 108.80 dinars per dollar. CHF is not
   on that snapshot, so it crosses from the indicative table the same way.
   The home currency is absent. Canada is the same function with the
   divisor equal to 1, so its mids stay CAD per unit. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { quoteHomeMarket } from "../src/rates/ticker-quotes.js";

const MIDS = { USD: 1.36, RSD: 0.0125 };
/* A day earlier the dollar was 1.30 CAD and the dinar 0.0130 CAD.
   Home per USD moves 100 → 108.8 (+8.80%). Home per CAD moves
   1/0.013 → 1/0.0125 (+4.00%), which is not 0.00% — CAD per CAD
   never moved, and that was the bug. The CAD-dollar move of USD
   itself is (1.36−1.30)/1.30 = 4.62%, and that is the Canada figure. */
const PRIOR = { USD: 1.3, RSD: 0.013 };

describe("quoteHomeMarket", () => {
  it("prices an RSD desk in dinars and hides the dinar", () => {
    const quoted = quoteHomeMarket("RSD", MIDS);
    expect(quoted.priced).toBe(true);
    const usd = quoted.quotes.find((q) => q.code === "USD");
    const chf = quoted.quotes.find((q) => q.code === "CHF");
    expect(usd).toBeTruthy();
    expect(chf).toBeTruthy();
    expect(new Decimal(usd!.mid).toDecimalPlaces(2).toFixed(2)).toBe("108.80");
    expect(usd!.chg).toBeNull();
    expect(chf!.chg).toBeNull();
    const chfHome = new Decimal(1).div("0.6512").div("0.0125");
    expect(new Decimal(chf!.mid).toDecimalPlaces(2).toFixed(2)).toBe(chfHome.toDecimalPlaces(2).toFixed(2));
    expect(Number(chf!.mid)).toBeGreaterThan(100);
    expect(quoted.quotes.some((q) => q.code === "RSD")).toBe(false);
    for (const quote of quoted.quotes) {
      const mid = new Decimal(quote.mid);
      expect(mid.equals("0.0125")).toBe(false);
      expect(mid.toDecimalPlaces(4).equals(new Decimal(1).div("0.6512").toDecimalPlaces(4))).toBe(false);
      expect(mid.toDecimalPlaces(5).equals("0.89366")).toBe(false);
    }
  });

  it("measures the change on the home cross, against the snapshot a day earlier", () => {
    const quoted = quoteHomeMarket("RSD", MIDS, PRIOR);
    const usd = quoted.quotes.find((q) => q.code === "USD")!;
    const cad = quoted.quotes.find((q) => q.code === "CAD")!;
    const chf = quoted.quotes.find((q) => q.code === "CHF")!;
    expect(usd.chg).toBe("8.80");
    expect(cad.chg).toBe("4.00");
    expect(chf.chg).toBeNull();
  });

  it("leaves a Canada desk in Canadian dollars per unit", () => {
    const quoted = quoteHomeMarket("CAD", MIDS, PRIOR);
    const usd = quoted.quotes.find((q) => q.code === "USD")!;
    const chf = quoted.quotes.find((q) => q.code === "CHF")!;
    expect(new Decimal(usd.mid).toFixed(2)).toBe("1.36");
    expect(usd.chg).toBe("4.62");
    expect(new Decimal(chf.mid).toDecimalPlaces(4).toFixed(4)).toBe(new Decimal(1).div("0.6512").toDecimalPlaces(4).toFixed(4));
    expect(quoted.quotes.some((q) => q.code === "CAD")).toBe(false);
  });

  it("does not invent a cross when the home currency has no market rate", () => {
    const quoted = quoteHomeMarket("RSD", { USD: 1.36 });
    expect(quoted).toEqual({ priced: false, quotes: [] });
  });
});

describe("GET /api/rates/ticker for an RSD desk", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let logged: string[] = [];
  let rsdSession = "";

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    process.env.EARLY_ACCESS_OPEN = "1";
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    const started = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Terazije Test",
        ownerName: "Milan Jovanovic",
        email: "milan@ticker-rsd.example",
        password: "ticker-desk-2026",
        slug: "tickersd",
        onboarding: { country: "Serbia", homeCurrency: "RSD", city: "Belgrade" },
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const line = [...logged].reverse().find((l) => l.includes("milan@ticker-rsd.example"));
    const code = line?.match(/(\d{6}) is your/)?.[1] ?? line?.match(/code is (\d{6})/)?.[1];
    expect(code).toBeTruthy();
    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "milan@ticker-rsd.example", code },
    });
    expect(verified.statusCode, verified.body).toBe(201);
    const now = new Date();
    await handle.db.insert(schema.marketRates).values({
      id: "snap-ticker-rsd",
      provider: "test",
      mids: MIDS,
      fetchedAt: now,
    });
    await handle.db.insert(schema.marketRates).values({
      id: "snap-ticker-rsd-prior",
      provider: "test",
      mids: PRIOR,
      fetchedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });
    rsdSession = await rsdCookie();
  });

  async function rsdCookie() {
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      payload: { staffId: "milan@ticker-rsd.example", password: "ticker-desk-2026", tenantId: "tnt-tickersd" },
    });
    expect(start.statusCode, start.body).toBe(200);
    const line = [...logged].reverse().find((l) => l.includes("milan@ticker-rsd.example") && /\d{6}/.test(l));
    const code = line?.match(/(\d{6}) is your/)?.[1] ?? line?.match(/code is (\d{6})/)?.[1];
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/login/verify",
      payload: { staffId: "milan@ticker-rsd.example", code, tenantId: "tnt-tickersd" },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.cookies.find((c) => c.name === "cdos_session")!.value;
  }

  async function tapeFor(cookie: string) {
    const tape = await app.inject({
      method: "GET",
      url: "/api/rates/ticker",
      cookies: { cdos_session: cookie },
    });
    expect(tape.statusCode, tape.body).toBe(200);
    return tape.json() as { home: string | null; priced: boolean; quotes: { code: string; mid: string; chg: string | null }[] };
  }

  afterAll(async () => {
    await app.close();
    await handle.close();
    vi.restoreAllMocks();
    delete process.env.EARLY_ACCESS_OPEN;
  });

  it("shows USD near 108.80, a dinar CHF, and the dinar cross's own change", async () => {
    const body = await tapeFor(rsdSession);
    expect(body.home).toBe("RSD");
    expect(body.priced).toBe(true);
    const usd = body.quotes.find((q) => q.code === "USD")!;
    const cad = body.quotes.find((q) => q.code === "CAD")!;
    const chf = body.quotes.find((q) => q.code === "CHF")!;
    expect(new Decimal(usd.mid).toDecimalPlaces(2).toFixed(2)).toBe("108.80");
    expect(usd.chg).toBe("8.80");
    expect(cad.chg).toBe("4.00");
    expect(chf.chg).toBeNull();
    expect(Number(chf.mid)).toBeGreaterThan(100);
    expect(body.quotes.some((q) => q.code === "RSD")).toBe(false);
    for (const quote of body.quotes) {
      const mid = new Decimal(quote.mid);
      expect(mid.toDecimalPlaces(2).equals("1.36")).toBe(false);
      expect(mid.equals("0.0125")).toBe(false);
      expect(mid.toDecimalPlaces(4).equals(new Decimal(1).div("0.6512").toDecimalPlaces(4))).toBe(false);
      expect(mid.toDecimalPlaces(5).equals(new Decimal(1).div("1.119").toDecimalPlaces(5))).toBe(false);
    }
  });

  it("omits the change when the current snapshot is older than a day", async () => {
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await handle.db.update(schema.marketRates).set({ fetchedAt: aged }).where(eq(schema.marketRates.id, "snap-ticker-rsd"));
    await handle.db.update(schema.marketRates).set({
      fetchedAt: new Date(aged.getTime() - 25 * 60 * 60 * 1000),
    }).where(eq(schema.marketRates.id, "snap-ticker-rsd-prior"));
    try {
      const body = await tapeFor(rsdSession);
      const usd = body.quotes.find((q) => q.code === "USD")!;
      expect(new Decimal(usd.mid).toDecimalPlaces(2).toFixed(2)).toBe("108.80");
      expect(body.quotes.every((q) => q.chg == null)).toBe(true);
    } finally {
      const now = new Date();
      await handle.db.update(schema.marketRates).set({ fetchedAt: now }).where(eq(schema.marketRates.id, "snap-ticker-rsd"));
      await handle.db.update(schema.marketRates).set({
        fetchedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      }).where(eq(schema.marketRates.id, "snap-ticker-rsd-prior"));
    }
  });

  it("returns an empty tape when the desk has no home currency", async () => {
    await handle.db.update(schema.legalEntities).set({ homeCurrency: null }).where(eq(schema.legalEntities.homeCurrency, "RSD"));
    try {
      const body = await tapeFor(rsdSession);
      expect(body).toEqual({ home: null, priced: false, quotes: [] });
    } finally {
      await handle.db.update(schema.legalEntities).set({ homeCurrency: "RSD" }).where(eq(schema.legalEntities.tenantId, "tnt-tickersd"));
    }
  });

  it("leaves the Canada desk's tape in CAD per unit", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "cdos_session");
    const tape = await app.inject({
      method: "GET",
      url: "/api/rates/ticker",
      cookies: { cdos_session: cookie!.value },
    });
    const body = tape.json() as { home: string; quotes: { code: string; mid: string; chg: string | null }[] };
    expect(body.home).toBe("CAD");
    const usd = body.quotes.find((q) => q.code === "USD")!;
    expect(new Decimal(usd.mid).toFixed(2)).toBe("1.36");
    expect(usd.chg).toBe("4.62");
    expect(body.quotes.some((q) => q.code === "CAD")).toBe(false);
  });
});
