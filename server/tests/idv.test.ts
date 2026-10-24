import * as crypto from "node:crypto";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const equalSpy = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  equalSpy.mockImplementation((left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => actual.timingSafeEqual(left, right));
  return { ...actual, timingSafeEqual: equalSpy };
});
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { createPersonaProvider } from "../src/idv/providers/persona/index.js";
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

function withSecrets(env: Record<string, string>) {
  const provider = createPersonaProvider(env);
  if (!provider) throw new Error("fixture provider");
  return provider;
}

describe("persona webhook signature", () => {
  const raw = Buffer.from("{\"a\":1}");
  const t = Math.floor(NOW / 1000);
  const provider = () => withSecrets({ PERSONA_WEBHOOK_SECRET: SECRET, PERSONA_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
  const check = (signature: string) => provider().verifyWebhook({ rawBody: raw, headers: headers(signature), now: NOW });

  it("accepts a valid signature", () => { expect(check(signed(SECRET, raw, t))).toBe(true); });
  it("rejects a bad signature", () => {
    expect(check(signed(SECRET, raw, t).replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBe(false);
  });
  it("rejects an expired signature", () => { expect(check(signed(SECRET, raw, t - 301))).toBe(false); });
  it("accepts either secret during rotation", () => {
    const header = `t=${t - 301},v1=${"ab".repeat(32)} t=${t},v1=${mac(PREVIOUS, raw, t)}`;
    expect(check(header)).toBe(true);
  });
  it("is absent when the keys are blank", () => {
    expect(createPersonaProvider({})).toBeNull();
    expect(createPersonaProvider({ PERSONA_WEBHOOK_SECRET: "  " })).toBeNull();
  });
  it("verifies the exact raw bytes, not the re-serialized payload", () => {
    const pretty = Buffer.from('{\n  "a": 1\n}');
    const compact = Buffer.from(JSON.stringify(JSON.parse(pretty.toString("utf8"))));
    expect(compact.equals(pretty)).toBe(false);
    const signature = signed(SECRET, pretty, t);
    const persona = withSecrets({ PERSONA_WEBHOOK_SECRET: SECRET });
    expect(persona.verifyWebhook({ rawBody: pretty, headers: headers(signature), now: NOW })).toBe(true);
    expect(persona.verifyWebhook({ rawBody: compact, headers: headers(signature), now: NOW })).toBe(false);
  });
  it("compares v1 with timingSafeEqual", () => {
    equalSpy.mockClear();
    expect(check(signed(SECRET, raw, t))).toBe(true);
    const v1 = Buffer.from(mac(SECRET, raw, t), "hex");
    const view = (value: NodeJS.ArrayBufferView) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const calls = (crypto.timingSafeEqual as unknown as typeof equalSpy).mock.calls;
    const matched = calls.some(([left, right]) => view(left as NodeJS.ArrayBufferView).equals(v1) || view(right as NodeJS.ArrayBufferView).equals(v1));
    expect(crypto.timingSafeEqual).toBe(equalSpy);
    expect(matched).toBe(true);
  });
});

describe("idv webhook", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let off: FastifyInstance;

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    handle = await createDb();
    const persona = withSecrets({ PERSONA_WEBHOOK_SECRET: SECRET, PERSONA_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
    app = await buildApp(handle.db, {}, undefined, { persona });
    off = await buildApp(handle.db, {}, undefined, { persona: createPersonaProvider({}) });
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
