/* Two tellers, one desk.

   Every browser holds a whole copy of the desk's document and writes it back
   entire. Before this, the last writer won: teller B's save silently erased
   whatever teller A had done since B's page loaded. No error, no log, nothing
   on either screen — the work was simply not there the next morning.

   Two halves are tested here. The server refuses a save built on a version
   that has moved (below), and the client merges the two documents key by key
   rather than one side losing everything (state-merge.test.ts).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let cookies: Record<string, string> = {};

const read = () => app.inject({ method: "GET", url: "/api/tenant/state", cookies });
const write = (state: Record<string, unknown>, version?: number) =>
  app.inject({
    method: "PUT",
    url: "/api/tenant/state",
    cookies,
    payload: version === undefined ? { state } : { state, version },
  });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  cookies = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });

// each test starts from a desk nobody has written to yet
beforeEach(async () => {
  await handle.db.delete(schema.tenantState).where(eq(schema.tenantState.tenantId, "tnt-yorkfx"));
});

describe("the version travels with the document", () => {
  it("starts at nothing and counts up on every save", async () => {
    expect((await read()).json().version).toBe(0);
    expect((await write({ a: "1" }, 0)).json().version).toBe(1);
    expect((await write({ a: "2" }, 1)).json().version).toBe(2);
    expect((await read()).json().version).toBe(2);
  });
});

describe("a save built on a version that has moved", () => {
  it("is refused rather than allowed to erase the other one", async () => {
    // both tellers load the same desk
    await write({ clients: "one" }, 0);
    const a = (await read()).json().version;
    const b = a;

    // A adds a client
    expect((await write({ clients: "one,two" }, a)).statusCode).toBe(200);

    // B, still holding the older version, saves settings
    const res = await write({ clients: "one", settings: "changed" }, b);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("state_conflict");
  });

  it("hands back the current document, so the loser can merge instead of guessing", async () => {
    await write({ clients: "one" }, 0);
    const stale = (await read()).json().version;
    await write({ clients: "one,two" }, stale);

    const res = await write({ clients: "one", settings: "changed" }, stale);
    expect(res.json().state).toEqual({ clients: "one,two" });
    expect(res.json().version).toBe(stale + 1);
  });

  it("changes nothing — the refusal is a refusal", async () => {
    await write({ clients: "one" }, 0);
    const stale = (await read()).json().version;
    await write({ clients: "one,two" }, stale);
    await write({ clients: "WIPED" }, stale);

    expect((await read()).json().state).toEqual({ clients: "one,two" });
  });

  /* Having merged, the client saves again on the version it was handed. That
     second save is the one that must land — otherwise a busy desk conflicts
     forever and never writes anything. */
  it("goes through once it is rebuilt on the version it was given", async () => {
    await write({ clients: "one" }, 0);
    const stale = (await read()).json().version;
    await write({ clients: "one,two" }, stale);

    const conflict = (await write({ clients: "one", settings: "changed" }, stale)).json();
    const merged = { ...conflict.state, settings: "changed" };   // what the bridge does
    const res = await write(merged, conflict.version);

    expect(res.statusCode).toBe(200);
    expect((await read()).json().state).toEqual({ clients: "one,two", settings: "changed" });
  });
});

describe("a browser that was already open when this shipped", () => {
  /* Sends no version, because its copy of the bridge predates the field.
     Breaking its saves to fix a race would be a bad trade — it keeps the old
     last-write-wins behaviour until it is closed. */
  it("still saves, exactly as it did before", async () => {
    await write({ a: "1" }, 0);
    const res = await write({ a: "2" });
    expect(res.statusCode).toBe(200);
    expect((await read()).json().state).toEqual({ a: "2" });
  });

  it("still moves the version on, so current browsers stay protected from it", async () => {
    await write({ a: "1" }, 0);
    const before = (await read()).json().version;
    await write({ a: "2" });
    expect((await read()).json().version).toBe(before + 1);
  });
});

describe("the first save of a brand new desk", () => {
  it("is not a conflict — there is nothing to conflict with", async () => {
    const res = await write({ cdos_settings: "{}" }, 0);
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
  });
});
