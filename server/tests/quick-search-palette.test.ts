/* Quick search, the part that decides what the box offers.

   The palette paints in the browser. What it is allowed to offer is
   decided in os-src/cdos-palette.js, and deals are judged by the same
   makeSearch the Ledger screen already runs. Both are loaded here
   rather than copied, so a change to either is what this file sees.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Item {
  kind: string;
  id: string;
  title: string;
  app?: string | null;
  name?: string | null;
}

interface Group {
  id: string;
  items: Item[];
}

interface Palette {
  isPaletteChord: (e: {
    key?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
  }) => boolean;
  clientHit: (name: string, rec: Record<string, unknown>, needle: string) => boolean;
  query: (opts: Record<string, unknown>) => { groups: Group[]; items: Item[] };
  moveIndex: (index: number, dir: string, count: number) => number;
  readRecent: (storage: Memory) => Item[];
  remember: (storage: Memory, item: Item) => Item[];
}

interface SearchApi {
  makeSearch: (query: string) => { active: boolean; match: (row: Record<string, unknown>) => boolean };
}

interface Memory {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
}

function load(file: string, win: Record<string, unknown>) {
  const src = readFileSync(resolve(process.cwd(), "../os-src", file), "utf8");
  const sandbox = { window: win };
  // eslint-disable-next-line no-new-func
  new Function("window", src)(sandbox.window);
}

function loadApis(): { palette: Palette; search: SearchApi } {
  const win: Record<string, unknown> = { CDOS: { TODAY: "2026-10-07" } };
  load("cdos-search.jsx", win);
  load("cdos-palette.js", win);
  return { palette: win.CDOS_PALETTE as Palette, search: win.CDOS as SearchApi };
}

function memory(): Memory {
  const box = new Map<string, string>();
  return {
    getItem: (k) => (box.has(k) ? box.get(k)! : null),
    setItem: (k, v) => { box.set(k, String(v)); },
  };
}

const { palette: P, search } = loadApis();

const owner = () => true;
const cashier = (id: string) => id !== "till" && id !== "settings";

const brooke = {
  clientId: "cli_brooke_lawson",
  phone: "416-555-0142",
  docs: [{ fileId: "file_1", label: "Proof of address", fileName: "hydro-bill.pdf" }],
};

const deal = {
  id: "row_1",
  ref: "LT-261007-004",
  customer: "Brooke Lawson",
  inAmt: 500,
  inCcy: "CAD",
  outAmt: 365.5,
  outCcy: "USD",
  fee: 4,
  status: "posted",
  type: "Currency Exchange",
  teller: "A. Singh",
  notes: "",
  date: "2026-10-07",
  time: "10:00",
  thread: [],
};

const titles = (result: { groups: Group[] }, group: string) =>
  (result.groups.find((g) => g.id === group)?.items ?? []).map((item) => item.title);

describe("the shortcut", () => {
  it("is Cmd K or Ctrl K, and not a shifted, repeated, or bare K", () => {
    expect(P.isPaletteChord({ key: "k", metaKey: true })).toBe(true);
    expect(P.isPaletteChord({ key: "K", ctrlKey: true })).toBe(true);
    expect(P.isPaletteChord({ key: "k", metaKey: true, shiftKey: true })).toBe(false);
    expect(P.isPaletteChord({ key: "k", ctrlKey: true, altKey: true })).toBe(false);
    expect(P.isPaletteChord({ key: "k", ctrlKey: true, repeat: true })).toBe(false);
    expect(P.isPaletteChord({ key: "k" })).toBe(false);
    expect(P.isPaletteChord({ key: "p", metaKey: true })).toBe(false);
  });
});

describe("moving through the list", () => {
  it("wraps at both ends and stays put when the list is empty", () => {
    expect(P.moveIndex(0, "up", 3)).toBe(2);
    expect(P.moveIndex(2, "down", 3)).toBe(0);
    expect(P.moveIndex(1, "down", 3)).toBe(2);
    expect(P.moveIndex(0, "down", 0)).toBe(0);
  });
});

describe("who can jump where", () => {
  it("offers an owner every screen and a cashier only the ones the dock would", () => {
    const all = P.query({ query: "", canOpen: owner, recent: [] });
    expect(all.groups.map((g) => g.id)).toEqual(["screens"]);
    expect(all.groups[0]!.items.map((item) => item.app)).toEqual([
      "till", "ledger", "clients", "settings", "rates",
    ]);
    const limited = P.query({ query: "", canOpen: cashier, recent: [] });
    expect(limited.groups[0]!.items.map((item) => item.app)).toEqual(["ledger", "clients", "rates"]);
    expect(titles(P.query({ query: "set", canOpen: cashier }), "screens")).toEqual([]);
    expect(titles(P.query({ query: "till", canOpen: cashier }), "screens")).toEqual([]);
    expect(titles(P.query({ query: "rate", canOpen: cashier }), "screens")).toEqual(["Rate board"]);
  });

  it("drops a recent screen the person can no longer open, and keeps a recent client", () => {
    const recent = [
      { kind: "screen", id: "screen:till", title: "Till", app: "till" },
      { kind: "client", id: "client:brooke", title: "Brooke Lawson", name: "Brooke Lawson" },
    ];
    const result = P.query({ query: "", canOpen: cashier, recent });
    expect(result.groups[0]!.id).toBe("recent");
    expect(result.groups[0]!.items.map((item) => item.title)).toEqual(["Brooke Lawson"]);
    expect(result.groups[1]!.id).toBe("screens");
  });
});

describe("what a query matches", () => {
  it("matches a client by name, minted id, and phone, and a file by its label", () => {
    expect(P.clientHit("Brooke Lawson", brooke, "brooke")).toBe(true);
    expect(P.clientHit("Brooke Lawson", brooke, "cli_brooke")).toBe(true);
    expect(P.clientHit("Brooke Lawson", brooke, "5550142")).toBe(true);
    expect(P.clientHit("Brooke Lawson", brooke, "marcus")).toBe(false);

    const found = P.query({
      query: "brooke",
      clients: { "Brooke Lawson": brooke, "Marcus Reed": { clientId: "cli_marcus", phone: "647-555-0190" } },
      canOpen: owner,
      rows: [],
      makeSearch: search.makeSearch,
    });
    expect(titles(found, "clients")).toEqual(["Brooke Lawson"]);
    expect(found.items.some((item) => item.title === "Marcus Reed")).toBe(false);

    const file = P.query({
      query: "hydro",
      clients: { "Brooke Lawson": brooke },
      canOpen: owner,
      makeSearch: search.makeSearch,
    });
    expect(titles(file, "files")).toEqual(["Proof of address"]);
    expect(titles(file, "clients")).toEqual([]);
  });

  it("judges a deal with the ledger matcher, by receipt, amount, and client", () => {
    const byRef = P.query({ query: "LT-261007-004", rows: [deal], canOpen: owner, makeSearch: search.makeSearch });
    expect(titles(byRef, "deals")).toEqual(["LT-261007-004"]);
    const byAmount = P.query({ query: "500", rows: [deal], canOpen: owner, makeSearch: search.makeSearch });
    expect(titles(byAmount, "deals")).toEqual(["LT-261007-004"]);
    const byClient = P.query({ query: "Brooke Lawson", rows: [deal], canOpen: owner, makeSearch: search.makeSearch });
    expect(titles(byClient, "deals")).toEqual(["LT-261007-004"]);
  });

  it("does not invent a client who was not handed in, even when the box is empty", () => {
    const empty = P.query({
      query: "",
      clients: { "Brooke Lawson": brooke },
      rows: [deal],
      canOpen: owner,
      recent: [],
      makeSearch: search.makeSearch,
    });
    expect(empty.items.every((item) => item.kind === "screen")).toBe(true);
    const typed = P.query({ query: "wei zhang", clients: { "Brooke Lawson": brooke }, canOpen: owner, makeSearch: search.makeSearch });
    expect(titles(typed, "clients")).toEqual([]);
  });
});

describe("recent items", () => {
  it("remembers the newest first and reads them back", () => {
    const store = memory();
    P.remember(store, { kind: "client", id: "client:a", title: "A" });
    P.remember(store, { kind: "deal", id: "deal:b", title: "B" });
    expect(P.readRecent(store).map((item) => item.title)).toEqual(["B", "A"]);
  });
});
