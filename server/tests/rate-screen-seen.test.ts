/* Rates v2.5: a window screen says it is on.

   A screen asks for its rates every minute. Each time it does, the server
   notes when it was last seen, at most once a minute per screen, so a TV
   in the window shows as "On" at the desk. The desk's own preview of a
   screen does not count, and a link that is not a screen writes nothing. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forgetPublicAnswers, forgetScreenSightings } from "../src/rates/public-board.js";

let handle: DbHandle;
let app: FastifyInstance;
let owner: Record<string, string> = {};
const pub = (url: string) => app.inject({ method: "GET", url });
const seenAt = async (id: string) => (await handle.db.select().from(schema.windowScreens).where(eq(schema.windowScreens.id, id)))[0]!.lastSeenAt;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: DEMO.password } });
  owner = { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(async () => {
  await handle.db.execute(sql`DELETE FROM window_screens`);
  forgetPublicAnswers();
  forgetScreenSightings();
});
const make = async () => (await app.inject({ method: "POST", url: "/api/window-screens", cookies: owner,
  payload: { name: "Window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true } })).json() as { id: string; token: string; lastSeenAt: number | null };

describe("a screen that is on", () => {
  it("is not seen until it asks for its rates, then the desk sees when", async () => {
    const screen = await make();
    expect(screen.lastSeenAt).toBeNull();
    const before = Date.now();
    expect((await pub(`/api/public/screens/${screen.token}`)).statusCode).toBe(200);
    const seen = await seenAt(screen.id);
    expect(seen!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const listed = (await app.inject({ method: "GET", url: "/api/window-screens", cookies: owner })).json().screens[0];
    expect(listed.lastSeenAt).toBe(seen!.getTime());
  });

  it("is written at most once a minute, even when its answer comes from memory", async () => {
    const screen = await make();
    await pub(`/api/public/screens/${screen.token}`);
    const first = await seenAt(screen.id);
    await pub(`/api/public/screens/${screen.token}`);
    expect((await seenAt(screen.id))!.getTime()).toBe(first!.getTime());
  });

  it("does not count the desk's own preview, and a link that is not a screen writes nothing", async () => {
    const screen = await make();
    expect((await pub(`/api/public/screens/${screen.token}?preview`)).statusCode).toBe(200);
    expect(await seenAt(screen.id)).toBeNull();
    expect((await pub("/api/public/screens/not-a-real-token-but-long-enough-xx")).statusCode).toBe(404);
  });
});
