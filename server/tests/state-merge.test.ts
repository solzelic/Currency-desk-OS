/* The three-way merge in the browser's persistence bridge.

   When the server refuses a save because somebody else got there first, the
   client has both documents and has to decide, key by key, whose version
   survives. Getting this wrong is worse than the bug it fixes: a merge that
   drops the wrong side loses work just as silently, only now with a
   mechanism that looks deliberate.

   Tested here rather than in the browser because it is pure — three objects
   in, one out — and because the failure it prevents (a teller's afternoon)
   deserves better than being exercised only by chance during an e2e run.

   Loaded out of the shipped file itself, not a copy. A copy would keep
   passing after somebody edited the real one.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* The bridge is a browser IIFE that assigns to window. Give it just enough
   of a window to load, then take the function off the object it exports. */
function loadMerge(): (b: unknown, m: unknown, t: unknown) => Record<string, string> {
  const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-persist.js"), "utf8");
  const win: Record<string, unknown> = {};
  const sandbox = {
    window: win,
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }), body: { appendChild: () => {} } },
    console,
    fetch: async () => ({ ok: false, status: 0 }),
    Date,
    JSON,
    Object,
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));
  const bridge = win.CDOS_PERSIST as { _merge: (b: unknown, m: unknown, t: unknown) => Record<string, string> };
  return bridge._merge;
}

const merge = loadMerge();

describe("two tellers who touched different things", () => {
  /* The case this whole mechanism exists for. One adds a client, the other
     changes a setting, and before this one of them lost. */
  it("both keep their work", () => {
    const base = { clients: "one", settings: "old" };
    const mine = { clients: "one", settings: "new" };     // I changed settings
    const theirs = { clients: "one,two", settings: "old" }; // they added a client
    expect(merge(base, mine, theirs)).toEqual({ clients: "one,two", settings: "new" });
  });

  it("keeps a key only one of them created", () => {
    const base = { a: "1" };
    const mine = { a: "1", mine: "x" };
    const theirs = { a: "1", theirs: "y" };
    expect(merge(base, mine, theirs)).toEqual({ a: "1", mine: "x", theirs: "y" });
  });
});

describe("a key neither of us changed", () => {
  it("survives untouched", () => {
    expect(merge({ a: "1" }, { a: "1" }, { a: "1" })).toEqual({ a: "1" });
  });
});

describe("a key we did not touch and they did", () => {
  it("takes theirs — it is not ours to decide", () => {
    expect(merge({ a: "1" }, { a: "1" }, { a: "2" })).toEqual({ a: "2" });
  });

  it("takes their deletion too", () => {
    expect(merge({ a: "1", b: "2" }, { a: "1", b: "2" }, { a: "1" })).toEqual({ a: "1" });
  });
});

describe("a key we did change", () => {
  it("stands, even against their newer one", () => {
    expect(merge({ a: "1" }, { a: "mine" }, { a: "theirs" })).toEqual({ a: "mine" });
  });

  it("stays deleted if we deleted it", () => {
    expect(merge({ a: "1", b: "2" }, { a: "1" }, { a: "1", b: "2" })).toEqual({ a: "1" });
  });

  /* We deleted it, they edited it. Ours wins, consistently with every other
     conflict: the person at this screen is the one who will notice. */
  it("stays deleted even if they edited it", () => {
    expect(merge({ a: "1", b: "2" }, { a: "1" }, { a: "1", b: "changed" })).toEqual({ a: "1" });
  });
});

describe("the honest limitation", () => {
  /* Both edited the same key and ours wins, so theirs is lost. Written down
     as a test rather than left as a surprise: cdos_rows_v1 is ONE key holding
     every transaction, so two tellers trading at once is exactly this. The
     merge does not save that case and is not pretending to — the answer is
     one row per transaction in a table, which is the next piece of work. */
  it("loses the other side when both edited the same key", () => {
    const base = { cdos_rows_v1: "[1,2]" };
    const mine = { cdos_rows_v1: "[1,2,3]" };
    const theirs = { cdos_rows_v1: "[1,2,4]" };
    expect(merge(base, mine, theirs)).toEqual({ cdos_rows_v1: "[1,2,3]" });
  });
});

describe("edges that would throw if this were careless", () => {
  it("handles an empty baseline — a desk saving for the first time", () => {
    expect(merge({}, { a: "1" }, {})).toEqual({ a: "1" });
  });

  it("handles nothing at all on any side", () => {
    expect(merge({}, {}, {})).toEqual({});
    expect(merge(null, null, null)).toEqual({});
  });

  it("does not invent a key nobody has", () => {
    expect(merge({ a: "1" }, {}, {})).toEqual({});
  });
});
