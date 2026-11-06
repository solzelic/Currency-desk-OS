/* A read already on its way is not asked for again (os-src/cdos-backend.js).

   Several desk screens read the same thing as they open, each for itself:
   Reports asked GET /api/ledger/summary six times for the same day. A GET
   for the same till and address as one still in flight now shares its
   answer, each caller getting its own copy. An answered read is never
   reused, and a write forgets everything in flight, as it starts and as it
   ends, so no read asked after a change gets an answer from before it.

   The desk's Backend is loaded here with a fetch the test answers by hand. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
/* The Backend reads the ID-type catalogue as it loads, as the desk does. */
createRequire(import.meta.url)("../../shared/id-document-types.js");
const ID_TYPES = (globalThis as { CDOS_ID_TYPES?: unknown }).CDOS_ID_TYPES;
const source = readFileSync(resolve(root, "os-src/cdos-backend.js"), "utf8");

type Call = { path: string; init: { method?: string; headers?: Record<string, string> }; answer: (body: unknown, status?: number) => void };
type Backend = {
  request: (path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<unknown>;
  setWorkspace: (id: string | null) => void;
};

let calls: Call[];
let B: Backend;

beforeEach(() => {
  calls = [];
  const fetch = (path: string, init: Call["init"]) => new Promise((done) => {
    calls.push({ path, init, answer: (body, status = 200) => done({ ok: status < 400, status, json: async () => body }) });
  });
  const window = { CDOS: {} as Record<string, unknown>, CDOS_ID_TYPES: ID_TYPES };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  new Function("window", "fetch", "document", "localStorage", source)(window, fetch, { addEventListener() {}, removeEventListener() {} }, storage);
  B = window.CDOS.Backend as Backend;
});

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("reads asked at the same moment", () => {
  it("are asked of the server once, and each caller gets its own copy", async () => {
    const a = B.request("/api/ledger/summary?from=x");
    const b = B.request("/api/ledger/summary?from=x");
    expect(calls).toHaveLength(1);
    calls[0]!.answer({ rows: [{ ccy: "USD" }] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ rows: [{ ccy: "USD" }] });
    expect(rb).toEqual(ra);
    expect(rb).not.toBe(ra);
    (ra as { rows: unknown[] }).rows.push("changed by one screen");
    expect((rb as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("are asked again once the first has been answered", async () => {
    const a = B.request("/api/ledger/position");
    calls[0]!.answer({ n: 1 });
    await a;
    const b = B.request("/api/ledger/position");
    expect(calls).toHaveLength(2);
    calls[1]!.answer({ n: 2 });
    expect(await b).toEqual({ n: 2 });
  });

  it("are asked separately for another address or another till", () => {
    void B.request("/api/ledger/position");
    void B.request("/api/ledger/vault");
    B.setWorkspace("ws-a");
    void B.request("/api/ledger/position");
    void B.request("/api/ledger/position", { headers: { "x-workspace-id": "ws-b" } });
    void B.request("/api/ledger/position");
    expect(calls.map((c) => c.path)).toEqual(["/api/ledger/position", "/api/ledger/vault", "/api/ledger/position", "/api/ledger/position"]);
    expect(calls[2]!.init.headers!["x-workspace-id"]).toBe("ws-a");
    expect(calls[3]!.init.headers!["x-workspace-id"]).toBe("ws-b");
  });

  it("share a refusal too, with the server's words", async () => {
    const a = B.request("/api/ledger/till-session");
    const b = B.request("/api/ledger/till-session");
    expect(calls).toHaveLength(1);
    calls[0]!.answer({ code: "TILL_NOT_OPEN" }, 409);
    await expect(a).rejects.toThrow("Open the till before posting or recording cash activity.");
    await expect(b).rejects.toThrow("Open the till before posting or recording cash activity.");
  });
});

describe("a write", () => {
  it("is never shared", () => {
    void B.request("/api/ledger/vault/receipts", { method: "POST", body: "{}" });
    void B.request("/api/ledger/vault/receipts", { method: "POST", body: "{}" });
    expect(calls).toHaveLength(2);
  });

  it("means a read asked after it starts is asked again", () => {
    void B.request("/api/ledger/position");
    void B.request("/api/ledger/vault/receipts", { method: "POST", body: "{}" });
    void B.request("/api/ledger/position");
    expect(calls.map((c) => c.init.method || "GET")).toEqual(["GET", "POST", "GET"]);
  });

  it("means a read asked after it ends is asked again, even one begun while it ran", async () => {
    const write = B.request("/api/ledger/vault/receipts", { method: "POST", body: "{}" });
    void B.request("/api/ledger/position");
    expect(calls).toHaveLength(2);
    calls[0]!.answer({ ok: true });
    await write;
    await settle();
    void B.request("/api/ledger/position");
    expect(calls).toHaveLength(3);
  });
});
