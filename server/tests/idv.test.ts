import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { personaProvider } from "../src/idv/providers/persona/index.js";
import { countIdvEvents, insertIdvInquiry, listIdvEvents } from "../src/idv/store.js";

const SECRET = "fixture-webhook-secret";
const PREVIOUS = "fixture-webhook-secret-previous";
const NOW = 1_700_000_000_000;
const mac = (secret: string, body: Buffer, t: number) =>
  createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest("hex");
const signed = (secret: string, body: Buffer, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${mac(secret, body, t)}`;
const headers = (signature: string) => ({ "persona-signature": signature });
function rawFor(eventId: string, referenceId: string, providerRef: string, decoyShop: string): string {
  return JSON.stringify({
    shop_id: decoyShop,
    data: { id: eventId, attributes: { name: "inquiry.approved", payload: { data: {
      id: providerRef, attributes: { status: "approved", "reference-id": referenceId, shop_id: decoyShop, name: "not-stored" },
    } } } },
  });
}

describe("persona webhook signature", () => {
  const raw = Buffer.from("{\"a\":1}");
  const t = Math.floor(NOW / 1000);
  const check = (signature: string, secrets: readonly string[]) =>
    personaProvider.verifyWebhook({ rawBody: raw, headers: headers(signature), secrets, now: NOW });

  it("accepts a valid signature", () => { expect(check(signed(SECRET, raw, t), [SECRET])).toBe(true); });
  it("rejects a bad signature", () => {
    expect(check(signed(SECRET, raw, t).replace(/.$/, (c) => (c === "a" ? "b" : "a")), [SECRET])).toBe(false);
  });
  it("rejects an expired signature", () => { expect(check(signed(SECRET, raw, t - 301), [SECRET])).toBe(false); });
  it("accepts either secret during rotation", () => {
    const header = `t=${t - 301},v1=${"ab".repeat(32)} t=${t},v1=${mac(PREVIOUS, raw, t)}`;
    expect(check(header, [SECRET, PREVIOUS])).toBe(true);
  });
  it("reads no secret when the keys are blank", () => {
    expect(personaProvider.secrets({})).toEqual([]);
    expect(personaProvider.secrets({ PERSONA_WEBHOOK_SECRET: "  " })).toEqual([]);
    const secrets = personaProvider.secrets({ PERSONA_WEBHOOK_SECRET: SECRET, PERSONA_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
    expect(secrets).toHaveLength(2);
    expect(check(signed(PREVIOUS, raw, t), secrets)).toBe(true);
  });
});

describe("idv webhook", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let off: FastifyInstance;

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    handle = await createDb();
    app = await buildApp(handle.db, {}, undefined, { secrets: () => [SECRET, PREVIOUS] });
    off = await buildApp(handle.db, {}, undefined, { secrets: () => [] });
    await insertIdvInquiry(handle.db, { referenceId: "ref-a", shopId: "shop-a", branchId: "br-a", tellerId: "teller-a", provider: "persona", providerRef: "inq_a" });
    await insertIdvInquiry(handle.db, { referenceId: "ref-b", shopId: "shop-b", branchId: "br-b", tellerId: "teller-b", provider: "persona", providerRef: "inq_b" });
  });
  afterAll(async () => { await app.close(); await off.close(); await handle.close(); });

  function post(target: FastifyInstance, raw: string, signature: string) {
    return target.inject({
      method: "POST", url: "/api/webhooks/idv/persona", payload: raw,
      headers: { "content-type": "application/json", "persona-signature": signature },
    });
  }

  it("is off without keys and writes nothing", async () => {
    const before = await countIdvEvents(handle.db);
    const raw = rawFor("evt_off", "ref-a", "inq_a", "shop-b");
    const res = await post(off, raw, signed(SECRET, Buffer.from(raw)));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "not_configured" });
    expect(await countIdvEvents(handle.db)).toBe(before);
  });

  it("drops an unknown reference with no write", async () => {
    const before = await countIdvEvents(handle.db);
    const raw = rawFor("evt_unknown", "ref-missing", "inq_missing", "shop-a");
    const res = await post(app, raw, signed(SECRET, Buffer.from(raw)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, dropped: true });
    expect(await countIdvEvents(handle.db)).toBe(before);
  });

  it("stores once, and shop A cannot read shop B", async () => {
    const rawA = rawFor("evt_a", "ref-a", "inq_a", "shop-b");
    const rawB = rawFor("evt_b", "ref-b", "inq_b", "shop-a");
    const first = await post(app, rawA, signed(SECRET, Buffer.from(rawA)));
    const again = await post(app, rawA, signed(SECRET, Buffer.from(rawA)));
    const other = await post(app, rawB, signed(PREVIOUS, Buffer.from(rawB)));
    expect(first.json()).toEqual({ received: true, duplicate: false });
    expect(again.json()).toEqual({ received: true, duplicate: true });
    expect(other.statusCode).toBe(200);
    expect(await countIdvEvents(handle.db)).toBe(2);
    const a = await listIdvEvents(handle.db, "shop-a");
    const b = await listIdvEvents(handle.db, "shop-b");
    expect(a).toEqual([{ eventId: "evt_a", referenceId: "ref-a", shopId: "shop-a", providerRef: "inq_a" }]);
    expect(b).toEqual([{ eventId: "evt_b", referenceId: "ref-b", shopId: "shop-b", providerRef: "inq_b" }]);
    expect(JSON.stringify(a)).not.toContain("shop-b");
    expect(JSON.stringify(a)).not.toContain("not-stored");
  });

  it("rejects a bad signature on the route and writes nothing", async () => {
    const before = await countIdvEvents(handle.db);
    const raw = rawFor("evt_bad", "ref-a", "inq_a", "shop-b");
    const res = await post(app, raw, signed("other-secret", Buffer.from(raw)));
    expect(res.statusCode).toBe(400);
    expect(await countIdvEvents(handle.db)).toBe(before);
  });
});
