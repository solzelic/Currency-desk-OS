/* Early Access v2.1, the page's side of the server (CD-177 to CD-183).

   The page (served at /early-access, sites.test.ts) reads its two switches at load from GET /api/site/early-access:
     · OPEN_SIGNUP=1 turns it into open sign-up (mode "open");
     · SAM_CALL=0 takes the SAM call off (samCall false).
   Unset, it is early access with the call on. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { forgetClaimedCount } from "../src/routes/early-access.js";

let handle: DbHandle;
let app: FastifyInstance;
const switches = async () => {
  forgetClaimedCount();
  return (await app.inject({ method: "GET", url: "/api/site/early-access" })).json() as { mode: string; samCall: boolean; claimed: number };
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });
afterEach(() => { delete process.env.OPEN_SIGNUP; delete process.env.SAM_CALL; });

describe("the two switches", () => {
  it("unset: early access, with the SAM call on", async () => {
    expect(await switches()).toMatchObject({ mode: "early_access", samCall: true });
  });

  it("OPEN_SIGNUP=1 is open sign-up; anything else is not", async () => {
    process.env.OPEN_SIGNUP = "1";
    expect((await switches()).mode).toBe("open");
    process.env.OPEN_SIGNUP = "0";
    expect((await switches()).mode).toBe("early_access");
  });

  it("SAM_CALL=0 takes the call off; SAM_CALL=1 keeps it", async () => {
    process.env.SAM_CALL = "0";
    expect((await switches()).samCall).toBe(false);
    process.env.SAM_CALL = "1";
    expect((await switches()).samCall).toBe(true);
  });

  it("still answers the founding count it always did", async () => {
    expect(typeof (await switches()).claimed).toBe("number");
  });
});
