/* The number we ring.

   The early-access form now asks for it, because the application promises a
   call within minutes of approval and chasing a phone number afterwards is
   how that promise gets broken. What matters server-side is that it arrives
   in a shape somebody can dial, and that a number we cannot parse still
   keeps its owner's place in the cohort. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { normalizePhone } from "../src/routes/enquiries.js";

let handle: DbHandle;
let app: FastifyInstance;

const apply = (email: string, details: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload: { kind: "early_access", email, name: "Nadia Haddad", details } as Record<string, unknown> });
const detailsOf = async (email: string) => {
  const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === email)!;
  return (row.details ?? {}) as Record<string, unknown>;
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });

describe("putting a number into a shape you can dial", () => {
  it("keeps only what can be dialled, however it was typed", () => {
    expect(normalizePhone("+1 416 555 0148")!.phone).toBe("+14165550148");
    expect(normalizePhone("(416) 555-0148")!.phone).toBe("+14165550148");
    expect(normalizePhone("416.555.0148")!.phone).toBe("+14165550148");
    // a bare ten-digit number is North American, which is where every desk is
    expect(normalizePhone("4165550148")!.phone).toBe("+14165550148");
    // and a country code they gave us is theirs, not ours to replace
    expect(normalizePhone("+44 20 7946 0958")!.phone).toBe("+442079460958");
  });

  it("says when it could not make sense of one, instead of guessing", () => {
    expect(normalizePhone("+1 416 555 0148")!.ok).toBe(true);
    expect(normalizePhone("555")!.ok).toBe(false);
    expect(normalizePhone("call the shop")!.ok).toBe(false);
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe("what the form sends", () => {
  it("stores the number dialable, and the hour they said to ring", async () => {
    expect((await apply("dial@bayfx.ca", { phone: "+1 4165550148", bestTime: "Afternoons", jurisdiction: "CA" })).statusCode).toBe(201);
    const d = await detailsOf("dial@bayfx.ca");
    expect(d.phone).toBe("+14165550148");
    expect(d.bestTime).toBe("Afternoons");
    expect(d.phoneUnparsed).toBeUndefined();
  });

  /* A public form that rejects a phone number loses the application. Somebody
     typing an extension, a country we did not list, or a word costs us a lead
     — so it is kept, flagged, and a person looks. */
  it("still takes the application when the number makes no sense", async () => {
    const res = await apply("odd@bayfx.ca", { phone: "ring the shop, ext 4", jurisdiction: "CA" });
    expect(res.statusCode).toBe(201);
    expect(res.json().charterNo).toBeGreaterThan(0);
    const d = await detailsOf("odd@bayfx.ca");
    expect(d.phoneUnparsed).toBe("ring the shop, ext 4");
  });

  it("does not invent one when they applied before we asked", async () => {
    await apply("nophone@bayfx.ca", { jurisdiction: "CA" });
    const d = await detailsOf("nophone@bayfx.ca");
    expect(d.phone).toBeUndefined();
    expect(d.phoneUnparsed).toBeUndefined();
  });
});
