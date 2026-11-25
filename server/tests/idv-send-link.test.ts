/* Email the Didit link. No SMS. Staging mail is @staging.invalid only.
   A missing provider or mail setup is 503. Logs and the audit stay masked. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resetIdvSendLimits, idvLinkMessage, idvLinkSubject, PRIVACY_CONTACT_MESSAGE } from "../src/idv/send-link.js";
import { PROVINCE_LINE, QUEBEC_LINE } from "../src/idv/tiers.js";

const KEYS = {
  DIDIT_API_KEY: "fixture-didit-key",
  DIDIT_WEBHOOK_SECRET: "fixture-didit-secret",
  DIDIT_WORKFLOW_ID: "89c8dc5a-2673-4603-973a-b7172aa33c33",
};
const SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const URL = "https://verify.didit.me/session/fixturetoken";
const EMAIL = "a.client@staging.invalid";
const SHOP = "York Currency Exchange Inc.";
const CONTACT = "Privacy officer";
const REPLY = "privacy@staging.invalid";
const SUBJECT = `Your ID check link from ${SHOP}`;
const BODY = `${SHOP} sent you this link to complete your ID check:\n${URL}\n\nIf you did not ask for this, you can ignore it, or contact ${SHOP} at ${CONTACT}.`;
const fetchStub: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.endsWith("/decision/")) return new Response("no", { status: 404 });
  return new Response(JSON.stringify({ session_url: URL }), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

let handle: DbHandle;
let app: FastifyInstance;
let bare: FastifyInstance;
let off: FastifyInstance;
let live: FastifyInstance;
let staging: FastifyInstance;
const sent: Array<{ to: string; subject: string; text: string; replyTo?: string }> = [];
let clock = 1_700_000_000_000;
const cookies: Record<string, { cdos_session: string }> = {};

function cookieOf(res: { cookies: { name: string; value: string }[] }) {
  return { cdos_session: res.cookies.find((item) => item.name === "cdos_session")!.value };
}
async function signIn(target: FastifyInstance, staffId: string) {
  const res = await target.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
}
const mail = async (to: string, subject: string, text: string, replyTo?: string) => {
  sent.push({ to, subject, text, replyTo });
  return "sent" as const;
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
  await handle.db.execute(sql`
    INSERT INTO idv_shop_config (shop_id, provider, checks_enabled, privacy_contact, privacy_email, privacy_phone, privacy_policy_url)
    VALUES (${DEMO.legalEntityId}, 'didit', true, 'Privacy officer', 'privacy@staging.invalid', '416-555-0100', 'https://example.com/privacy')
    ON CONFLICT (shop_id) DO UPDATE SET provider = 'didit', checks_enabled = true,
      privacy_contact = 'Privacy officer', privacy_email = 'privacy@staging.invalid',
      privacy_phone = '416-555-0100', privacy_policy_url = 'https://example.com/privacy'
  `);
  await handle.db.execute(sql`
    INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
    VALUES ('cli-send', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Send Fixture')
    ON CONFLICT (client_id) DO NOTHING
  `);
  await handle.db.execute(sql`
    INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier)
    VALUES ('ref-send-1', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${SESSION}, 'cli-send', '3')
  `);
  await handle.db.execute(sql`
    INSERT INTO legal_entities (id, tenant_id, name)
    VALUES ('le-other-shop', ${DEMO.tenantId}, 'Other Shop')
    ON CONFLICT (id) DO NOTHING
  `);
  await handle.db.execute(sql`
    INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier)
    VALUES ('ref-send-other', 'le-other-shop', ${DEMO.branchId}, 'm.costa', 'didit', '77777777-8888-4999-8aaa-bbbbbbbbbbbb', 'cli-send', '3')
  `);
  await handle.db.execute(sql`
    INSERT INTO idv_consents
      (consent_id, tenant_id, legal_entity_id, branch_id, client_id, copy_version, language, inquiry_id, choice, staff_id, face_crop_shown)
    VALUES ('cns-send-1', ${DEMO.tenantId}, ${DEMO.legalEntityId}, ${DEMO.branchId}, 'cli-send', 'didit-1', 'en', ${SESSION}, 'agreed', 'm.costa', false)
  `);
  await handle.db.execute(sql`
    INSERT INTO staff_users (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, authorized_branch_ids, password_hash)
    SELECT 'tnt-yorkfx:a.auditor', tenant_id, legal_entity_id, branch_id, 'a.auditor', 'A. Auditor', 'auditor', authorized_branch_ids, password_hash
      FROM staff_users WHERE staff_id = 'm.costa'
  `);
  const opts = { fetch: fetchStub, mail, now: () => clock };
  app = await buildApp(handle.db, {}, undefined, { env: KEYS, ...opts });
  bare = await buildApp(handle.db, {}, undefined, { env: KEYS, fetch: fetchStub });
  off = await buildApp(handle.db, {}, undefined, { env: {}, ...opts });
  live = await buildApp(handle.db, {}, undefined, {
    env: { ...KEYS, RENDER: "true", RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com" },
    ...opts,
  });
  staging = await buildApp(handle.db, {}, undefined, {
    env: { ...KEYS, STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "staging.currencydeskos.com" },
    ...opts,
  });
  cookies.teller = await signIn(app, "m.costa");
  cookies.auditor = await signIn(app, "a.auditor");
  cookies.bare = await signIn(bare, "m.costa");
  cookies.off = await signIn(off, "m.costa");
  cookies.live = await signIn(live, "m.costa");
  cookies.staging = await signIn(staging, "m.costa");
});

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await off?.close();
  await live?.close();
  await staging?.close();
  await handle?.close();
});

beforeEach(() => {
  sent.length = 0;
  clock = 1_700_000_000_000;
  resetIdvSendLimits();
});

function post(target: FastifyInstance, cookie: { cdos_session: string } | undefined, inquiry: string, email: unknown) {
  return target.inject({
    method: "POST",
    url: `/api/idv/inquiries/${inquiry}/send-link`,
    cookies: cookie,
    payload: { email },
  });
}

describe("send the Didit link by email", () => {
  it("requires a signed-in teller on this shop", async () => {
    const open = await post(app, undefined, SESSION, EMAIL);
    expect(open.statusCode).toBe(401);
    const auditor = await post(app, cookies.auditor, SESSION, EMAIL);
    expect(auditor.statusCode).toBe(403);
    const other = await post(app, cookies.teller, "77777777-8888-4999-8aaa-bbbbbbbbbbbb", EMAIL);
    expect(other.statusCode).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("refuses a Quebec branch and an empty province before any email", async () => {
    try {
      await handle.db.update(schema.branches).set({ province: "QC" }).where(eq(schema.branches.id, DEMO.branchId));
      const quebec = await post(app, cookies.teller, SESSION, EMAIL);
      expect(quebec.statusCode).toBe(409);
      expect(quebec.json()).toEqual({ code: "COUNTER_ONLY", message: QUEBEC_LINE });
      expect(sent).toHaveLength(0);

      await handle.db.update(schema.branches).set({ province: null }).where(eq(schema.branches.id, DEMO.branchId));
      const empty = await post(app, cookies.teller, SESSION, EMAIL);
      expect(empty.statusCode).toBe(409);
      expect(empty.json()).toEqual({ code: "COUNTER_ONLY", message: PROVINCE_LINE });
      expect(sent).toHaveLength(0);
    } finally {
      await handle.db.update(schema.branches).set({ province: "ON" }).where(eq(schema.branches.id, DEMO.branchId));
    }
  });

  it("keeps the test shop and live locks and answers 503 when Didit or mail is missing", async () => {
    await handle.db.update(schema.tenants).set({ isTestShop: false }).where(eq(schema.tenants.id, DEMO.tenantId));
    const shop = await post(app, cookies.teller, SESSION, EMAIL);
    expect(shop.statusCode).toBe(409);
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    const locked = await post(live, cookies.live, SESSION, EMAIL);
    expect(locked.statusCode).toBe(409);
    const provider = await post(off, cookies.off, SESSION, EMAIL);
    expect(provider.statusCode).toBe(503);
    expect(provider.json()).toMatchObject({ error: "not_available", message: "The message was not sent." });
    const mailMissing = await post(bare, cookies.bare, SESSION, EMAIL);
    expect(mailMissing.statusCode).toBe(503);
    expect(mailMissing.json().message).toBe("The message was not sent.");
    expect(sent).toHaveLength(0);
  });

  it("sends the approved words, then waits, and stores a masked audit", async () => {
    const logs: string[] = [];
    const wrap = (name: "log" | "warn" | "error") => {
      const original = console[name].bind(console);
      console[name] = (...args: unknown[]) => {
        logs.push(args.map((part) => String(part)).join(" "));
        original(...args);
      };
      return original;
    };
    const restore = { log: wrap("log"), warn: wrap("warn"), error: wrap("error") };
    const first = await post(app, cookies.teller, SESSION, `  ${EMAIL}  `);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ sent: true });
    expect(idvLinkSubject(SHOP)).toBe(SUBJECT);
    expect(idvLinkMessage(SHOP, URL, CONTACT)).toBe(BODY);
    expect(sent).toEqual([{ to: EMAIL, subject: SUBJECT, text: BODY, replyTo: REPLY }]);
    const again = await post(app, cookies.teller, SESSION, EMAIL);
    expect(again.statusCode).toBe(429);
    expect(again.json().message).toBe("Wait a moment, then send it again.");
    clock += 61_000;
    const resent = await post(app, cookies.teller, SESSION, EMAIL);
    expect(resent.statusCode, resent.body).toBe(200);
    const rows = await handle.db.execute(sql`
      SELECT detail FROM audit_events WHERE action = 'idv.link_sent'
    `);
    const detail = rows.rows.at(-1)?.detail as { channel?: string; destination?: string; staffId?: string };
    expect(detail).toEqual({ channel: "email", destination: "a•••@s•••", staffId: "m.costa" });
    const dumped = JSON.stringify(rows.rows) + logs.join("\n");
    expect(dumped).not.toContain(EMAIL);
    expect(dumped).not.toContain(URL);
    expect(dumped).not.toContain("fixturetoken");
    console.log = restore.log;
    console.warn = restore.warn;
    console.error = restore.error;
  });

  it("refuses a real address on staging and a bad address anywhere", async () => {
    const bad = await post(app, cookies.teller, SESSION, "not-an-email");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe("That email is not valid.");
    const liveAddress = await post(staging, cookies.staging, SESSION, "person@example.com");
    expect(liveAddress.statusCode).toBe(400);
    const invented = await post(staging, cookies.staging, SESSION, EMAIL);
    expect(invented.statusCode, invented.body).toBe(200);
    expect(sent.map((item) => item.to)).toEqual([EMAIL]);
  });

  it("allows another send after the cooldown and stops the shop at 20 an hour", async () => {
    for (let n = 0; n < 20; n += 1) {
      clock += 61_000;
      const res = await post(app, cookies.teller, SESSION, EMAIL);
      expect(res.statusCode, res.body).toBe(200);
    }
    clock += 61_000;
    const blocked = await post(app, cookies.teller, SESSION, EMAIL);
    expect(blocked.statusCode).toBe(429);
    expect(sent).toHaveLength(20);
  });

  it("refuses a missing privacy contact and writes the copy and failure audits", async () => {
    try {
      await handle.db.execute(sql`UPDATE idv_shop_config SET privacy_contact = NULL WHERE shop_id = ${DEMO.legalEntityId}`);
      const refused = await post(app, cookies.teller, SESSION, EMAIL);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: "PRIVACY_CONTACT", message: PRIVACY_CONTACT_MESSAGE });
      expect(refused.body).not.toContain(URL);
      expect(refused.body).not.toContain("sent you this link");
      expect(sent).toHaveLength(0);
      const failed = await handle.db.execute(sql`
        SELECT detail FROM audit_events WHERE action = 'idv.link_failed' ORDER BY at DESC
      `);
      const failDetail = failed.rows[0]?.detail as { channel?: string; destination?: string; staffId?: string };
      expect(failDetail).toEqual({ channel: "email", destination: "a•••@s•••", staffId: "m.costa" });
      expect(JSON.stringify(failDetail)).not.toContain(URL);
      expect(JSON.stringify(failDetail)).not.toContain(EMAIL);
    } finally {
      await handle.db.execute(sql`
        UPDATE idv_shop_config SET privacy_contact = 'Privacy officer' WHERE shop_id = ${DEMO.legalEntityId}
      `);
    }

    const copiedLink = await app.inject({
      method: "POST",
      url: `/api/idv/inquiries/${SESSION}/link-note`,
      cookies: cookies.teller,
      payload: { kind: "link" },
    });
    expect(copiedLink.statusCode, copiedLink.body).toBe(200);
    expect(copiedLink.json()).toEqual({ recorded: true });
    const copiedText = await app.inject({
      method: "POST",
      url: `/api/idv/inquiries/${SESSION}/link-note`,
      cookies: cookies.teller,
      payload: { kind: "text" },
    });
    expect(copiedText.statusCode, copiedText.body).toBe(200);
    expect(copiedText.json().text).toBe(BODY);
    const notes = await handle.db.execute(sql`
      SELECT detail->>'channel' AS channel, detail FROM audit_events WHERE action = 'idv.link_copied' ORDER BY at
    `);
    const channels = notes.rows.map((row) => (row as { channel?: string }).channel);
    expect(channels).toEqual(["copy_link", "copy_text"]);
    const dumped = JSON.stringify(notes.rows);
    expect(dumped).not.toContain(URL);
    expect(dumped).not.toContain(EMAIL);
    expect(dumped).not.toContain("fixturetoken");
  });
});
