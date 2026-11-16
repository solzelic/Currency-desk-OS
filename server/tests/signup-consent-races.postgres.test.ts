import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { withSignupAccount } from "../src/onboarding/signup-account.js";
import { registerEnquirySamRoutes } from "../src/routes/enquiry-sam.js";
import { SAM_CONSENT_TEXT } from "../src/enquiries/sam.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("SAM booking versus committed opt-out", () => {
  let handle: DbHandle, inspector: pg.Pool;
  beforeAll(async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    try { handle = await createDb(); }
    finally { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; }
    inspector = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => { await inspector?.end(); await handle?.close(); });
  it("a booking waiting behind opt-out cannot restore its cancelled schedule", async () => {
    const id = randomUUID(), reference = "CD-SAM234";
    await handle.db.insert(schema.enquiries).values({ id, reference, cdId: `CD-RACE-${id}`, kind: "early_access", status: "invited", email: "synthetic@example.test", details: { phone: "+14165550123" } });
    await handle.db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: id, event: "consent", phone: "+14165550123", consentText: SAM_CONSENT_TEXT, at: new Date(Date.now() - 1000) });
    const app = Fastify(); registerEnquirySamRoutes(app, handle.db); await app.ready();
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { locked = r; });
    const stop = withSignupAccount(handle.db, id, async db => {
      await db.insert(schema.enquiryCallConsents).values({ id: randomUUID(), enquiryId: id, event: "stop", phone: "+14165550123" });
      await db.update(schema.enquiries).set({ samCallAt: null }).where(eq(schema.enquiries.id, id));
      locked(); await barrier;
    });
    try {
      await ready;
      const booking = app.inject({ method: "POST", url: `/api/enquiries/${reference}/sam`, payload: {} }).then(r => r);
      // Observe the database waiter, not an arbitrary sleep or presumed timing.
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const result = await inspector.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND (query LIKE '%signup_accounts%' OR query LIKE '%enquiries%')");
        if (result.rowCount) { waiting = true; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      release(); await stop;
      const response = await booking;
      expect(waiting, "booking reached the held row lock").toBe(true);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("no_consent");
      expect((await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, id)))[0]?.samCallAt).toBeNull();
    } finally {
      release(); await stop; await app.close();
    }
  });
});
