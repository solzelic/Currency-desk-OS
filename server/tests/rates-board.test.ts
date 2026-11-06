/* The Rates app's board, as the browser builds it (os-src/rates-board.js).

   The server prices every deal and every public number. These are the
   desk's own copies: the preview a manager sees before publishing, and the
   body the Publish button sends. Margins are fractions on the wire and
   percents on screen; a spread of 1.5 means 1.5%, sent as 0.015. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Row = { code: string; mid: number | null; spreadPct: number; custom: boolean; pinned: boolean; show: boolean; published: boolean };
const board = () => require("../../os-src/rates-board.js") as {
  deskPair: (mid: number, buyPct: number, sellPct: number) => { buy: number; sell: number };
  draftRows: (input: {
    codes: string[]; home: string; board: { rows: Record<string, { mid: number; spread?: number; show?: boolean }>; order?: string[] } | null;
    market: Record<string, string>; settings: { spreads?: Record<string, unknown>; defaultSpread?: unknown; spotOverride?: Record<string, unknown> };
  }) => Row[];
  publishBody: (rows: Row[], defaultSpreadPct: number) => { ok: true; body: { buyMargin: number; sellMargin: number; rows: Record<string, unknown>; order: string[] } } | { ok: false; missing: string[] };
  homeMarket: (mids: Record<string, unknown> | null | undefined, home: string) => Record<string, number>;
  floorFor: (settings: { marginFloorPct?: unknown; marginFloorByCcy?: unknown } | null | undefined, code: string) => number;
  feeFor: (settings: { defaultFee?: unknown; feeTiers?: unknown } | null | undefined, homeAmount: number) => number | null;
  sameAsPublished: (rows: Row[], published: { rows: Record<string, { mid: number; spread?: number; show?: boolean }>; order?: string[] } | null, defaultSpreadPct: number) => boolean;
  READ_REUSE_MS: number;
  reusableRead: <T>(read: { value: T | null; askedAt: number } | null | undefined, now: number, recordedAt: number) => T | null;
};

describe("the desk's two lines", () => {
  it("buys at mid x (1 - m) and sells at mid / (1 - m), six places, the same as the server", () => {
    expect(board().deskPair(2, 3, 3)).toEqual({ buy: 1.94, sell: 2.061856 });
    expect(board().deskPair(1.5, 10, 10)).toEqual({ buy: 1.35, sell: 1.666667 });
    expect(board().deskPair(0.0091, 1.5, 1.5)).toEqual({ buy: 0.008964, sell: 0.009239 });
  });
});

/* Found on a running desk: the ticker rounds to six places, which moved
   the dong 0.56% and the won 0.03% off the market. The board takes the raw
   market mids (CAD per unit) and only divides, never rounds. */
describe("the market in the shop's home currency", () => {
  const mids = { CAD: 1, USD: 1.3994195, EUR: 1.5665, VND: 0.000054305116, KRW: 0.0010406816, BAD: -1, ALSO: "x" };
  it("keeps every digit for a CAD shop and leaves out the home currency and nonsense", () => {
    expect(board().homeMarket(mids, "CAD")).toEqual({ USD: 1.3994195, EUR: 1.5665, VND: 0.000054305116, KRW: 0.0010406816 });
  });
  it("crosses through the home currency for any other shop", () => {
    const usd = board().homeMarket(mids, "USD");
    expect(usd.CAD).toBe(1 / 1.3994195);
    expect(usd.EUR).toBe(1.5665 / 1.3994195);
    expect(usd).not.toHaveProperty("USD");
  });
  it("has no market when the feed cannot price the home currency", () => {
    expect(board().homeMarket(mids, "AED")).toEqual({});
    expect(board().homeMarket(null, "CAD")).toEqual({});
  });
});

describe("the draft board", () => {
  const settings = { defaultSpread: 1.5, spreads: { USD: "0.8" }, spotOverride: { GBP: "1.80" } };
  const published = { rows: { EUR: { mid: 1.47 }, USD: { mid: 1.36, spread: 0.008 }, JPY: { mid: 0.0091, show: false } }, order: ["EUR", "USD", "JPY"] };

  it("keeps the published order, then the desk's other currencies, and never lists the home currency", () => {
    const rows = board().draftRows({ codes: ["CAD", "USD", "EUR", "GBP", "JPY"], home: "CAD", board: published, market: { USD: "1.3641", EUR: "1.4710", JPY: "0.0091", GBP: "1.73" }, settings });
    expect(rows.map((r) => r.code)).toEqual(["EUR", "USD", "JPY", "GBP"]);
  });

  it("takes a pinned rate first, then the market, then the last publish, and the desk's spreads", () => {
    const rows = board().draftRows({ codes: ["USD", "EUR", "GBP", "JPY", "MXN"], home: "CAD", board: published, market: { USD: "1.3641" }, settings });
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by.USD).toMatchObject({ mid: 1.3641, spreadPct: 0.8, custom: true, pinned: false, show: true, published: true });
    expect(by.EUR).toMatchObject({ mid: 1.47, spreadPct: 1.5, custom: false });
    expect(by.GBP).toMatchObject({ mid: 1.8, pinned: true, show: true, published: false });
    expect(by.JPY).toMatchObject({ show: false });
    expect(by.MXN).toMatchObject({ mid: null });
  });
});

describe("what Publish sends", () => {
  it("sends fractions, the order, every row with its show flag, and a spread only where one is set", () => {
    const rows = board().draftRows({ codes: ["USD", "EUR"], home: "CAD", board: null, market: { USD: "1.3641", EUR: "1.4710" }, settings: { defaultSpread: 1.5, spreads: { USD: 0.8 } } });
    rows[1]!.show = false;
    const out = board().publishBody(rows, 1.5);
    expect(out).toEqual({ ok: true, body: {
      buyMargin: 0.015, sellMargin: 0.015, order: ["USD", "EUR"],
      rows: { USD: { mid: 1.3641, spread: 0.008, show: true }, EUR: { mid: 1.471, show: false } },
    } });
  });

  it("marks a pinned rate, so the market sync leaves it alone", () => {
    const rows = board().draftRows({ codes: ["USD", "GBP"], home: "CAD", board: null, market: { USD: "1.3641", GBP: "1.70" }, settings: { spotOverride: { GBP: 1.8 } } });
    const out = board().publishBody(rows, 1.5);
    expect(out.ok && out.body.rows).toEqual({ USD: { mid: 1.3641, show: true }, GBP: { mid: 1.8, show: true, pinned: true } });
  });

  it("refuses a shown currency with no rate, and names it", () => {
    const rows = board().draftRows({ codes: ["USD", "MXN"], home: "CAD", board: null, market: { USD: "1.36" }, settings: {} });
    expect(board().publishBody(rows, 1.5)).toEqual({ ok: false, missing: ["MXN"] });
    rows[1]!.show = false;
    expect(board().publishBody(rows, 1.5).ok).toBe(true);
  });

  it("counts pinning or unpinning a rate as a change, even at the same mid", () => {
    const rows = board().draftRows({ codes: ["USD"], home: "CAD", board: null, market: { USD: "1.36" }, settings: { spotOverride: { USD: 1.36 } } });
    const unpinned = { buyMargin: 0.015, sellMargin: 0.015, rows: { USD: { mid: 1.36, show: true } }, order: ["USD"] };
    expect(board().sameAsPublished(rows, unpinned, 1.5)).toBe(false);
    const pinned = { ...unpinned, rows: { USD: { mid: 1.36, show: true, pinned: true } } };
    expect(board().sameAsPublished(rows, pinned, 1.5)).toBe(true);
    const free = board().draftRows({ codes: ["USD"], home: "CAD", board: null, market: { USD: "1.36" }, settings: {} });
    expect(board().sameAsPublished(free, pinned, 1.5)).toBe(false);
  });

  it("knows when the draft already matches the last publish", () => {
    const published = { rows: { USD: { mid: 1.36, spread: 0.008, show: true } }, order: ["USD"] };
    const rows = board().draftRows({ codes: ["USD"], home: "CAD", board: published, market: { USD: "1.36" }, settings: { defaultSpread: 1.5, spreads: { USD: 0.8 } } });
    expect(board().sameAsPublished(rows, published, 1.5)).toBe(true);
    rows[0]!.show = false;
    expect(board().sameAsPublished(rows, published, 1.5)).toBe(false);
  });

  it("ignores the home currency in the published order, which the seed board lists first", async () => {
    const published = { rows: { USD: { mid: 1.36 } }, order: ["CAD", "USD"], buyMargin: 0.015, sellMargin: 0.015 };
    const rows = board().draftRows({ codes: ["CAD", "USD"], home: "CAD", board: published, market: {}, settings: { defaultSpread: 1.5 } });
    expect(board().sameAsPublished(rows, published, 1.5)).toBe(true);
  });
});

/* Rates v2.5 commission tiers (Pricing & rates): a flat fee on every
   deal, and bigger deals can pay a different one. The new-deal screen
   fills the fee in from the deal's size in the shop's own currency. */
describe("the fee a deal pays", () => {
  const settings = { defaultFee: 2, feeTiers: [{ over: 10000, fee: 25 }, { over: 50000, fee: 60 }] };
  it("is the flat fee up to the first tier, then the highest tier the deal is over", () => {
    expect(board().feeFor(settings, 750)).toBe(2);
    expect(board().feeFor(settings, 10000)).toBe(2);
    expect(board().feeFor(settings, 12000)).toBe(25);
    expect(board().feeFor(settings, 50001)).toBe(60);
  });
  it("takes tiers in any order, typed with commas, and ignores broken ones", () => {
    const typed = { defaultFee: "2", feeTiers: [{ over: "50,000", fee: "60" }, { over: "10,000", fee: "25" }, { over: "x", fee: 9 }, { over: 20000, fee: -1 }, null] };
    expect(board().feeFor(typed, 12000)).toBe(25);
    expect(board().feeFor(typed, 60000)).toBe(60);
  });
  it("is the flat fee with no tiers, and nothing when the shop has no fee", () => {
    expect(board().feeFor({ defaultFee: 5 }, 99999)).toBe(5);
    expect(board().feeFor({}, 500)).toBeNull();
    expect(board().feeFor(null, 500)).toBeNull();
    expect(board().feeFor({ defaultFee: "", feeTiers: [{ over: 1000, fee: 10 }] }, 500)).toBeNull();
    expect(board().feeFor({ defaultFee: "", feeTiers: [{ over: 1000, fee: 10 }] }, 5000)).toBe(10);
  });
});

/* Rates v2.5 Guardrails, floor by currency: a currency's own floor, or
   the shop's floor when it has none. */
describe("the floor a currency is held to", () => {
  it("is its own floor when it has one, else the shop's, else 0.5%", () => {
    const s = { marginFloorPct: 0.8, marginFloorByCcy: { USD: 0.3, GBP: "1.2", JPY: "", MXN: "x", TRY: -1 } };
    expect(board().floorFor(s, "USD")).toBe(0.3);
    expect(board().floorFor(s, "GBP")).toBe(1.2);
    expect(board().floorFor(s, "EUR")).toBe(0.8);
    expect(board().floorFor(s, "JPY")).toBe(0.8);
    expect(board().floorFor(s, "MXN")).toBe(0.8);
    expect(board().floorFor(s, "TRY")).toBe(0.8);
    expect(board().floorFor({}, "USD")).toBe(0.5);
    expect(board().floorFor(null, "USD")).toBe(0.5);
  });
});

/* Cost & stock shows what the Board already read (the board, the market,
   the desk's position, the cost method) instead of asking again. Only a
   read made in the last minute, and only one asked after the last Record
   cash bought: that delivery changed the position, so it is read again. */
describe("a read the Board made, for Cost & stock", () => {
  const read = { value: { ok: true }, askedAt: 1_000_000 };
  it("is reused for a minute", () => {
    expect(board().READ_REUSE_MS).toBe(60_000);
    expect(board().reusableRead(read, 1_000_000, 0)).toBe(read.value);
    expect(board().reusableRead(read, 1_059_999, 0)).toBe(read.value);
    expect(board().reusableRead(read, 1_060_000, 0)).toBeNull();
  });
  it("is not reused once cash bought was recorded after it was asked", () => {
    expect(board().reusableRead(read, 1_000_500, 999_999)).toBe(read.value);
    expect(board().reusableRead(read, 1_000_500, 1_000_000)).toBeNull();
    expect(board().reusableRead(read, 1_000_500, 1_000_400)).toBeNull();
  });
  it("is nothing when the Board has not read it, or read nothing", () => {
    expect(board().reusableRead(null, 1_000_000, 0)).toBeNull();
    expect(board().reusableRead(undefined, 1_000_000, 0)).toBeNull();
    expect(board().reusableRead({ value: null, askedAt: 1_000_000 }, 1_000_000, 0)).toBeNull();
  });
  it("is not reused from a clock that has gone backwards", () => {
    expect(board().reusableRead(read, 999_000, 0)).toBeNull();
  });
});

it("ships in the desk", () => {
  expect(readFileSync(new URL("../../CurrencyDesk OS.html", import.meta.url), "utf8")).toContain('<script src="os-src/rates-board.js"></script>');
  expect(readFileSync(new URL("../../CurrencyDesk OS.html", import.meta.url), "utf8")).toContain('src="os-src/cdos-rates.jsx"');
});
