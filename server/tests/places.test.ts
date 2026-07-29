/* Address lookup.

   The key lives here and never goes to the browser, so these are the tests
   that matter: that the endpoints are behind the invite code, that nothing
   breaks when Google is not configured, and that Google's bag of address
   components comes out as the five fields the desk actually wants. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { details, placesEnabled, suggest } from "../src/places.js";

let handle: DbHandle;
let app: FastifyInstance;
const W = "CD-WALKTHRU";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
afterEach(() => { delete process.env.GOOGLE_PLACES_API_KEY; vi.unstubAllGlobals(); });

describe("without a key", () => {
  it("is simply off, and says so rather than failing", async () => {
    expect(placesEnabled()).toBe(false);
    const res = await app.inject({ method: "GET", url: `/api/onboarding/${W}/places/suggest?q=88 Wellington` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, suggestions: [] });
  });
});

describe("who may spend the quota", () => {
  it("nobody without a real invite code — these calls cost money per keystroke", async () => {
    for (const ref of ["CD-ZZZZZZ", "CD-234567"]) {
      expect((await app.inject({ method: "GET", url: `/api/onboarding/${ref}/places/suggest?q=x` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/onboarding/${ref}/places/details?id=abc` })).statusCode).toBe(404);
    }
  });
});

describe("reading what Google sends back", () => {
  const googleSays = (body: unknown, ok = true) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body, text: async () => "" })));

  it("turns predictions into something the screen can show", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    googleSays({
      suggestions: [
        { placePrediction: { placeId: "PLACE_A", structuredFormat: { mainText: { text: "88 Wellington Street West" }, secondaryText: { text: "Toronto, ON, Canada" } } } },
        { queryPrediction: { text: { text: "ignore me" } } },
      ],
    });
    const out = await suggest("88 Welling", "CA", "tok");
    expect(out).toEqual([{ id: "PLACE_A", primary: "88 Wellington Street West", secondary: "Toronto, ON, Canada" }]);
  });

  it("does not ask at all for a couple of characters", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await suggest("88", "CA", "tok")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("folds the component bag into the five fields the desk wants", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    googleSays({
      addressComponents: [
        { longText: "88", shortText: "88", types: ["street_number"] },
        { longText: "Wellington Street West", shortText: "Wellington St W", types: ["route"] },
        { longText: "Toronto", shortText: "Toronto", types: ["locality", "political"] },
        { longText: "Ontario", shortText: "ON", types: ["administrative_area_level_1"] },
        { longText: "M5J 2H3", shortText: "M5J 2H3", types: ["postal_code"] },
        { longText: "Canada", shortText: "CA", types: ["country"] },
      ],
    });
    expect(await details("PLACE_A", "tok")).toEqual({
      street: "88 Wellington Street West",
      city: "Toronto",
      region: "Ontario",
      postal: "M5J 2H3",
      country: "Canada",
    });
  });

  it("uses postal_town where there is no locality, which is how the UK arrives", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    googleSays({
      addressComponents: [
        { longText: "10", types: ["street_number"] },
        { longText: "Downing Street", types: ["route"] },
        { longText: "London", types: ["postal_town"] },
        { longText: "England", types: ["administrative_area_level_1"] },
        { longText: "SW1A 2AA", types: ["postal_code"] },
        { longText: "United Kingdom", types: ["country"] },
      ],
    });
    const a = await details("PLACE_UK", "tok");
    expect(a?.city).toBe("London");
    expect(a?.street).toBe("10 Downing Street");
  });

  it("never throws when Google is unhappy — the address is still typeable", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    googleSays({ error: "over quota" }, false);
    expect(await suggest("88 Wellington", "CA", "tok")).toEqual([]);
    expect(await details("PLACE_A", "tok")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await suggest("88 Wellington", "CA", "tok")).toEqual([]);
    expect(await details("PLACE_A", "tok")).toBeNull();
  });

  it("tells the caller when the lookup failed rather than filling in nothing", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    googleSays({}, false);
    const res = await app.inject({ method: "GET", url: `/api/onboarding/${W}/places/details?id=PLACE_A` });
    expect(res.statusCode).toBe(502);
    expect(res.json().detail).toContain("type it in instead");
  });
});
