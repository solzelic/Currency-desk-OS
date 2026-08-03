/* The size of a desk's saved state, and what happens at the edge of it.

   This suite exists because the guard it tests could never run. The handler
   refused at 4 MB and said so in its own error message; no body limit was
   configured anywhere, so Fastify's 1 MiB default rejected first and the
   4 MB branch was unreachable code. Nothing caught it because nothing had
   ever sent a large body — the tests all used small ones, which is exactly
   the size at which both limits agree.

   So the first test here sends something between the two numbers. That is
   the whole point of it: a payload small enough for the real limit and too
   large for the one that was actually in force.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { MAX_STATE_BYTES, WARN_AT_BYTES } from "../src/state/contract.js";

let handle: DbHandle;
let app: FastifyInstance;
let cookies: Record<string, string> = {};

/* A state document of roughly `bytes`, shaped like the real thing: one key
   holding a long JSON string, which is what the OS actually stores. */
const stateOf = (bytes: number) => ({ cdos_rows_v1: "x".repeat(Math.max(0, bytes - 32)) });
const put = (state: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/tenant/state", cookies, payload: { state } });

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

describe("a desk that is bigger than one megabyte", () => {
  /* The regression, exactly. 1.5 MB was refused before this fix and is well
     inside the limit the code always claimed. */
  it("saves, because the limit is the one we documented and not Fastify's default", async () => {
    const res = await put(stateOf(Math.floor(1.5 * 1024 * 1024)));
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("comes back out again whole", async () => {
    const doc = stateOf(Math.floor(1.2 * 1024 * 1024));
    await put(doc);
    const got = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
    expect((got.json().state as Record<string, string>).cdos_rows_v1).toHaveLength(
      doc.cdos_rows_v1.length,
    );
  });
});

describe("past the limit", () => {
  /* Refused by US, not by the framework. The distinction is the point: our
     refusal names the size and says who to talk to, and a client can tell it
     apart from "the server is down" and stop retrying. */
  it("is our refusal, with the size and what to do", async () => {
    const res = await put(stateOf(MAX_STATE_BYTES + 64 * 1024));
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error).toBe("state_too_large");
    expect(body.bytes).toBeGreaterThan(MAX_STATE_BYTES);
    expect(body.limit).toBe(MAX_STATE_BYTES);
    // points at a person, because retrying cannot fix this
    expect(body.detail).toMatch(/Contact CurrencyDesk/);
    expect(body.detail).toMatch(/Nothing was saved/);
  });

  it("saves nothing — the previous state is still there", async () => {
    const good = { cdos_settings: JSON.stringify({ name: "Harbour FX" }) };
    await put(good);
    await put(stateOf(MAX_STATE_BYTES + 64 * 1024));
    const got = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
    expect((got.json().state as Record<string, string>).cdos_settings).toBe(good.cdos_settings);
  });

  /* Absurd bodies never get parsed into memory at all. Fastify answers this
     one, and it is allowed to be generic — nobody legitimate arrives here. */
  it("is stopped before it is read once it is truly absurd", async () => {
    const res = await put(stateOf(MAX_STATE_BYTES + 2 * 1024 * 1024));
    expect(res.statusCode).toBe(413);
  });
});

describe("approaching the limit", () => {
  /* Somebody should hear about this over a coffee, not mid-transaction. */
  it("says so while the save is still succeeding", async () => {
    const res = await put(stateOf(WARN_AT_BYTES + 128 * 1024));
    expect(res.statusCode).toBe(200);
    expect(res.json().nearingLimit).toBe(true);
    expect(res.json().limit).toBe(MAX_STATE_BYTES);
  });

  it("stays quiet for an ordinary desk", async () => {
    const res = await put({ cdos_settings: JSON.stringify({ name: "Harbour FX" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().nearingLimit).toBeUndefined();
  });
});
