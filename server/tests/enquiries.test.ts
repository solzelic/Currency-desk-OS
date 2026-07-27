/* What the public site sends us. The Early Access application and the
   contact form both tell the sender they will hear back, so the only
   behaviour that matters is that the message is actually kept. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const send = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/enquiries", payload });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("enquiries", () => {
  it("keeps an early-access application and answers with its reference", async () => {
    const res = await send({
      kind: "early_access",
      email: "Amir@Yorkville.example",
      name: "Amir Rostami",
      details: { workspace: "yorkville.currencydeskos.com", jurisdiction: "CA", employees: "2-5" },
    });
    expect(res.statusCode).toBe(201);
    const { reference } = res.json();
    expect(reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);

    const rows = await handle.db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.reference, reference));
    expect(rows).toHaveLength(1);
    const kept = rows[0]!;
    expect(kept).toMatchObject({ kind: "early_access", email: "amir@yorkville.example", name: "Amir Rostami" });
    // the answers the design collects ride along verbatim
    expect(kept.details).toMatchObject({ jurisdiction: "CA", employees: "2-5" });
    // applying is not opening a desk — nothing was created
    expect(await handle.db.select().from(schema.tenants)).toHaveLength(0);
  });

  it("keeps a contact message, and gives each one its own reference", async () => {
    const a = await send({ kind: "contact", email: "one@shop.example", details: { message: "hello" } });
    const b = await send({ kind: "contact", email: "two@shop.example", details: { message: "hello" } });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().reference).not.toBe(b.json().reference);

    const rows = await handle.db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.kind, "contact"))
      .orderBy(desc(schema.enquiries.createdAt));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("turns away anything that is not one of the two forms", async () => {
    expect((await send({ kind: "newsletter", email: "a@b.example" })).statusCode).toBe(400);
    expect((await send({ kind: "contact", email: "not-an-address" })).statusCode).toBe(400);
    expect((await send({ kind: "contact" })).statusCode).toBe(400);
    // a details blob is free-text, but not an unbounded one
    const huge = await send({ kind: "contact", email: "a@b.example", details: { message: "x".repeat(5000) } });
    expect(huge.statusCode).toBe(400);
  });

  it("stops one address flooding the inbox", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await send({ kind: "contact", email: "flood@shop.example", details: { message: "again" } })).statusCode);
    }
    expect(codes.filter((c) => c === 201).length).toBe(3);
    expect(codes.at(-1)).toBe(429);
    // and only what got through was kept
    const rows = await handle.db
      .select()
      .from(schema.enquiries)
      .where(eq(schema.enquiries.email, "flood@shop.example"));
    expect(rows).toHaveLength(3);
  });
});
