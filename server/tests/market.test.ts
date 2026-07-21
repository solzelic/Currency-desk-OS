/* Market-rate sync tests — injected fetcher, no network. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { normalizePerCad, syncMarketRates, syncMarketRatesIfStale, type MarketPull } from "../src/rates/market.js";

let handle: DbHandle;
let app: FastifyInstance;

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

describe("market rates", () => {
  it("normalizes units-per-CAD to board mids and ignores junk", () => {
    const mids = normalizePerCad({ USD: 0.7067, EUR: 0.6186, XAU: 0.0004, BADC: -1, JPY: 0 });
    expect(mids.USD).toBeCloseTo(1 / 0.7067, 5);
    expect(mids.EUR).toBeCloseTo(1 / 0.6186, 5);
    expect(mids.XAU).toBeUndefined(); // not a desk currency
    expect(mids.JPY).toBeUndefined(); // zero rate dropped
  });

  it("snapshots the pull and auto-publishes a board that keeps staff settings", async () => {
    // staff publish first: custom margins + a USD spread override
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "r.haddad", password: DEMO.password } });
    const cookies = { cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value };
    await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies,
      payload: { buyMargin: 0.02, sellMargin: 0.03, rows: { USD: { mid: 1.37, spread: 0.011 }, EUR: { mid: 1.47, show: false } }, order: ["CAD", "USD", "EUR"] },
    });

    const fakePull: MarketPull = {
      provider: "test-feed",
      providerTimestamp: "2026-07-12T00:00:00Z",
      mids: { USD: 1.4151, EUR: 1.6165 },
    };
    const result = await syncMarketRates(handle.db, DEMO.branchId, async () => fakePull);
    expect(result.ok).toBe(true);

    const current = await app.inject({ method: "GET", url: "/api/rates" });
    const { board } = current.json();
    expect(board.publishedBy).toBe("market-sync (test-feed)");
    expect(board.rows.USD.mid).toBeCloseTo(1.4151); // market mid moved
    expect(board.rows.USD.spread).toBeCloseTo(0.011); // staff spread kept
    expect(board.rows.EUR.show).toBe(false); // staff hide kept
    expect(board.buyMargin).toBeCloseTo(0.02); // staff margins kept
    expect(board.sellMargin).toBeCloseTo(0.03);
    expect(board.order).toEqual(["CAD", "USD", "EUR"]); // ordering kept

    const market = await app.inject({ method: "GET", url: "/api/rates/market" });
    expect(market.json().provider).toBe("test-feed");
    expect(market.json().mids.USD).toBeCloseTo(1.4151);
  });

  it("reports failure without throwing when the provider is down", async () => {
    const result = await syncMarketRates(handle.db, DEMO.branchId, async () => {
      throw new Error("provider exploded");
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("provider exploded");
  });

  it("gates on snapshot age: repeated boots within the gap don't re-pull", async () => {
    const before = (await handle.db.select().from(schema.marketRates)).length;
    let calls = 0;
    const feed = async (): Promise<MarketPull> => {
      calls += 1;
      return { provider: "gate-feed", providerTimestamp: null, mids: { USD: 1.4, EUR: 1.6 } };
    };
    const gateMs = 60 * 60 * 1000; // one hour

    // first call pulls (a snapshot exists from earlier tests, but far in the
    // "past" of this test only if stale) — force a fresh one, then re-check
    const first = await syncMarketRatesIfStale(handle.db, DEMO.branchId, 0, feed);
    expect(first.skipped).toBe(false);
    expect(calls).toBe(1);

    // three more "cold-start boots" inside the hour — all skip, no provider call
    for (let i = 0; i < 3; i++) {
      const again = await syncMarketRatesIfStale(handle.db, DEMO.branchId, gateMs, feed);
      expect(again.skipped).toBe(true);
    }
    expect(calls).toBe(1); // still one provider hit across four boots

    const after = (await handle.db.select().from(schema.marketRates)).length;
    expect(after).toBe(before + 1); // exactly one new snapshot, not four
  });

  it("pulls again once the snapshot ages past the gap", async () => {
    let calls = 0;
    const feed = async (): Promise<MarketPull> => {
      calls += 1;
      return { provider: "age-feed", providerTimestamp: null, mids: { USD: 1.41 } };
    };
    // gate of 0ms means the newest snapshot is always "stale" → always pulls
    await syncMarketRatesIfStale(handle.db, DEMO.branchId, 0, feed);
    await syncMarketRatesIfStale(handle.db, DEMO.branchId, 0, feed);
    expect(calls).toBe(2);
  });
});
