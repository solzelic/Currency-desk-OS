/* Didit sandbox adapter. Fixture payloads only. No live key and no network. */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { finishDiditWebhook } from "../src/idv/didit-webhook.js";
import {
  chargeForDiditOutcome, createDiditProvider, diditApiBase, diditDecisionChecks, diditSessionLink,
  diditWorkflowForTier, parseDiditWebhook, startDiditCheck,
} from "../src/idv/providers/didit.js";

const SECRET = "fixture-didit-secret";
const KEY = "fixture-didit-key";
const WORKFLOW = "89c8dc5a-2673-4603-973a-b7172aa33c33";
const AML = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ENV = {
  DIDIT_API_KEY: KEY,
  DIDIT_WEBHOOK_SECRET: SECRET,
  DIDIT_WORKFLOW_ID: WORKFLOW,
};
const RENDER_LIVE = {
  ...ENV,
  RENDER: "true",
  RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com",
};
const NOW = 1_700_000_000_000;
const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/didit/status-updated.json"));
const SESSION = "11111111-2222-4333-8444-555555555555";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

function mac(body: Buffer, secret = SECRET) {
  return createHmac("sha256", secret).update(body).digest("hex");
}
function headers(body: Buffer, seconds: number, secret = SECRET) {
  return { "content-type": "application/json", "x-timestamp": String(seconds), "x-signature": mac(body, secret) };
}

let handle: DbHandle;
let app: FastifyInstance;
let off: FastifyInstance;
let live: FastifyInstance;
const cookies: Record<string, Record<string, string>> = {};

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

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db, {}, undefined, { env: ENV, fetch: fetchStub, sleep: async () => {} });
  off = await buildApp(handle.db, {}, undefined, { env: {}, fetch: fetchStub });
  live = await buildApp(handle.db, {}, undefined, {
    env: RENDER_LIVE,
    fetch: fetchStub,
  });
  cookies.owner = await signIn(app, "j.masri");
  cookies.teller = await signIn(app, "m.costa");
  cookies.off = await signIn(off, "m.costa");
});

afterAll(async () => {
  await app?.close();
  await off?.close();
  await live?.close();
  await handle?.close();
});

const calls: Array<{ url: string; body: string; key: string }> = [];
let sessionCount = 0;
const fetchStub: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = String(init?.body ?? "");
  const key = (init?.headers as Record<string, string>)["x-api-key"] ?? "";
  calls.push({ url, body, key });
  const sent = body ? JSON.parse(body) as { vendor_data?: string } : {};
  const fixed = sent.vendor_data === "ref-didit-1" || sent.vendor_data === "ref-aml";
  sessionCount += 1;
  const id = fixed ? SESSION : `44444444-5555-4666-8777-${String(sessionCount).padStart(12, "0")}`;
  if (url.endsWith("/decision/")) {
    const fromPath = url.split("/v3/session/")[1]?.split("/")[0] ?? id;
    return new Response(JSON.stringify({
      session_id: fromPath,
      session_url: "https://verify.didit.me/session/fixturetoken",
      full_name: "Fixture Person",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    session_id: id,
    url: "https://verify.didit.me/session/fixturetoken",
    full_name: "Fixture Person",
  }), { status: 201, headers: { "content-type": "application/json" } });
};

describe("didit provider", () => {
  const provider = () => {
    const made = createDiditProvider(ENV);
    if (!made) throw new Error("fixture provider");
    return made;
  };
  const seconds = Math.floor(NOW / 1000);

  it("accepts a raw-body signature and rejects a bad one", () => {
    const check = provider();
    expect(check.verifyWebhook({ rawBody: FIXTURE, headers: headers(FIXTURE, seconds), now: NOW })).toBe(true);
    const bad = headers(FIXTURE, seconds);
    bad["x-signature"] = bad["x-signature"].replace(/.$/, (char) => (char === "a" ? "b" : "a"));
    expect(check.verifyWebhook({ rawBody: FIXTURE, headers: bad, now: NOW })).toBe(false);
  });

  it("rejects a stale timestamp and a missing signature", () => {
    const check = provider();
    expect(check.verifyWebhook({ rawBody: FIXTURE, headers: headers(FIXTURE, seconds - 301), now: NOW })).toBe(false);
    expect(check.verifyWebhook({ rawBody: FIXTURE, headers: headers(FIXTURE, seconds + 301), now: NOW })).toBe(false);
    expect(check.verifyWebhook({ rawBody: FIXTURE, headers: { "x-timestamp": String(seconds) }, now: NOW })).toBe(false);
  });

  it("accepts the v2 signature without the raw-body header", () => {
    const check = provider();
    const canonical = JSON.stringify(sortKeys(JSON.parse(FIXTURE.toString("utf8"))));
    const v2 = createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex");
    expect(check.verifyWebhook({
      rawBody: FIXTURE,
      headers: { "x-timestamp": String(seconds), "x-signature-v2": v2 },
      now: NOW,
    })).toBe(true);
    expect(check.verifyWebhook({
      rawBody: FIXTURE,
      headers: { "x-timestamp": String(seconds), "x-signature-v2": v2.replace(/.$/, "0") },
      now: NOW,
    })).toBe(false);
  });

  it("compares the signature with timingSafeEqual", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/idv/providers/didit.ts"), "utf8");
    const body = source.slice(source.indexOf("function macEqual"), source.indexOf("function shortenFloats"));
    expect(body).toContain("timingSafeEqual(");
    expect(body).not.toMatch(/===\s*supplied|supplied\s*===/);
  });

  it("maps fixture statuses and does not keep the decision", () => {
    const parsed = parseDiditWebhook(JSON.parse(FIXTURE.toString("utf8")));
    expect(parsed).toMatchObject({
      provider: "didit",
      providerRef: SESSION,
      outcome: "approved",
      eventId: `didit:${SESSION}:Approved`,
    });
    expect(JSON.stringify(parsed)).not.toContain("Fixture Person");
    expect(JSON.stringify(parsed)).not.toContain("FIXTURE0001");
    const abandoned = parseDiditWebhook({ webhook_type: "status.updated", session_id: SESSION, status: "Abandoned" });
    const declined = parseDiditWebhook({ webhook_type: "data.updated", session_id: SESSION, status: "Declined" });
    const review = parseDiditWebhook({ webhook_type: "status.updated", session_id: SESSION, status: "In Review" });
    const expired = parseDiditWebhook({ webhook_type: "status.updated", session_id: SESSION, status: "Expired" });
    expect(abandoned?.outcome).toBe("failed");
    expect(declined?.outcome).toBe("declined");
    expect(review?.inquiryStatus).toBe("needs review");
    expect(expired?.outcome).toBe("expired");
    expect(parseDiditWebhook({ webhook_type: "user.status.updated", session_id: SESSION, status: "Approved" })?.ignore).toBe(true);
  });

  it("does not charge a failed, abandoned, or declined scan", () => {
    expect(chargeForDiditOutcome("failed")).toBe("no_charge");
    expect(chargeForDiditOutcome("declined")).toBe("no_charge");
    expect(chargeForDiditOutcome("expired")).toBe("no_charge");
    expect(chargeForDiditOutcome("approved")).toBe("unbilled");
    const source = readFileSync(join(import.meta.dirname, "../src/idv/didit-webhook.ts"), "utf8");
    expect(source).not.toMatch(/\.settle\(/);
  });

  it("maps tier 3 to the basic workflow and leaves tier 4 unavailable", () => {
    expect(diditWorkflowForTier("3", ENV)).toEqual({ ok: true, workflowId: WORKFLOW });
    expect(diditWorkflowForTier("4", ENV)).toEqual({ ok: false, reason: "tier_unavailable" });
    expect(diditWorkflowForTier("4", { ...ENV, DIDIT_AML_WORKFLOW_ID: AML })).toEqual({ ok: false, reason: "tier_unavailable" });
    expect(diditWorkflowForTier("3", { ...ENV, DIDIT_AML_WORKFLOW_ID: AML })).toEqual(diditWorkflowForTier("3", ENV));
    expect(diditWorkflowForTier("1", ENV).ok).toBe(false);
    expect(diditWorkflowForTier("3", {}).ok).toBe(false);
    const routes = readFileSync(join(import.meta.dirname, "../src/idv/routes.ts"), "utf8");
    expect(routes).not.toContain("ID, selfie and database");
  });

  it("is absent when the key or secret is missing, and on live Render", () => {
    expect(createDiditProvider({})).toBeNull();
    expect(createDiditProvider({ DIDIT_WEBHOOK_SECRET: SECRET, DIDIT_WORKFLOW_ID: WORKFLOW })).toBeNull();
    expect(createDiditProvider({ DIDIT_API_KEY: KEY, DIDIT_WORKFLOW_ID: WORKFLOW })).toBeNull();
    expect(createDiditProvider(RENDER_LIVE)).toBeNull();
    expect(createDiditProvider({ ...RENDER_LIVE, DIDIT_LIVE_ALLOWED: "1" })).not.toBeNull();
    expect(diditApiBase({ ...RENDER_LIVE, DIDIT_API_BASE: "http://127.0.0.1:4198" })).toBe("https://verification.didit.me");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "http://127.0.0.1:4198" })).toBe("http://127.0.0.1:4198");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "http://verification.didit.me" })).toBe("https://verification.didit.me");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "https://user:secret@verification.didit.me" })).toBe("https://verification.didit.me");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "https://verification.didit.me:8443" })).toBe("https://verification.didit.me");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "https://verification.didit.me:443/v3" })).toBe("https://verification.didit.me");
    expect(diditApiBase({ ...ENV, DIDIT_API_BASE: "http://user:secret@127.0.0.1:4198" })).toBe("https://verification.didit.me");
    expect(createDiditProvider({
      ...ENV,
      RENDER: "true",
      STAGING: "1",
      RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com",
    })).not.toBeNull();
  });

  it("aborts a Didit call that does not answer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(10_000);
      const controller = new AbortController();
      controller.abort();
      return controller.signal;
    });
    const hung: typeof fetch = async (_url, init) => {
      if (!init?.signal?.aborted) throw new Error("missing timeout");
      throw new DOMException("The operation was aborted", "AbortError");
    };
    await expect(startDiditCheck({
      referenceId: "ref-timeout", shopId: "shop", branchId: "branch", tellerId: "teller", tier: "3",
    }, { env: ENV, fetch: hung, sleep: async () => {} })).rejects.toThrow(/abort/i);
    await expect(diditSessionLink({ sessionId: SESSION, env: ENV, fetchImpl: hung })).rejects.toThrow(/abort/i);
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeout.mockRestore();
  });

  it("creates a session with the workflow id and no customer fields", async () => {
    calls.length = 0;
    const started = await startDiditCheck({
      referenceId: "ref-didit-1", shopId: "shop", branchId: "branch", tellerId: "teller", tier: "3",
    }, { env: ENV, fetch: fetchStub, sleep: async () => {} });
    expect(started.providerRef).toBe(SESSION);
    expect(calls[0]?.url).toBe("https://verification.didit.me/v3/session/");
    expect(calls[0]?.key).toBe(KEY);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ workflow_id: WORKFLOW, vendor_data: "ref-didit-1" });
    expect(calls[0]?.body).not.toContain("Fixture Person");
    const before = calls.length;
    await expect(startDiditCheck({
      referenceId: "ref-aml", shopId: "shop", branchId: "branch", tellerId: "teller", tier: "4",
    }, { env: { ...ENV, DIDIT_AML_WORKFLOW_ID: AML }, fetch: fetchStub, sleep: async () => {} })).rejects.toThrow("tier_unavailable");
    expect(calls).toHaveLength(before);
    const passed = diditDecisionChecks({
      id_verifications: [{ status: "Approved", full_name: "Fixture Person" }],
      liveness_checks: [{ status: "Approved" }],
      face_matches: [{ status: "Approved" }],
    });
    expect(passed).toEqual({ passed: true, line: "ID passed, liveness passed, face match passed" });
    expect(passed.line).not.toContain("Fixture Person");
    expect(diditDecisionChecks({
      id_verifications: [{ status: "Approved" }],
      liveness_checks: [{ status: "Approved" }],
      face_matches: [{ status: "Declined" }],
    }).passed).toBe(false);
  });
});

describe("didit routes", () => {
  async function enable(provider: string) {
    await handle.db.execute(sql`
      INSERT INTO idv_shop_config (shop_id, provider, checks_enabled, privacy_contact, privacy_email, privacy_phone, privacy_policy_url)
      VALUES (${DEMO.legalEntityId}, ${provider}, true, 'Privacy officer', 'privacy@example.com', '416-555-0100', 'https://example.com/privacy')
      ON CONFLICT (shop_id) DO UPDATE SET provider = ${provider}, checks_enabled = true
    `);
  }

  it("answers 503 when the key and secret are missing", async () => {
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    await enable("didit");
    const hook = await off.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: FIXTURE.toString("utf8"),
      headers: headers(FIXTURE, Math.floor(Date.now() / 1000)),
    });
    expect(hook.statusCode).toBe(503);
    expect(hook.json()).toEqual({ error: "not_available" });
    const start = await off.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.off, payload: { tier: "3" },
    });
    expect(start.statusCode).toBe(503);
    expect(start.json()).toEqual({ error: "not_available" });
  });

  it("refuses Didit on a shop that is not a test shop", async () => {
    await handle.db.update(schema.tenants).set({ isTestShop: false }).where(eq(schema.tenants.id, DEMO.tenantId));
    const saved = await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner, payload: { provider: "didit" },
    });
    expect(saved.statusCode).toBe(422);
    expect(saved.json().message).toBe("Didit can be used only on a staging test shop.");
    await enable("didit");
    const start = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { tier: "3" },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json().message).toBe("Didit can be used only on a staging test shop.");
  });

  it("keeps Didit off on live Render unless the live flag is set", async () => {
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    const owner = await signIn(live, "j.masri");
    const teller = await signIn(live, "m.costa");
    const saved = await live.inject({
      method: "PUT", url: "/api/settings/idv", cookies: owner, payload: { provider: "didit", checksEnabled: true },
    });
    expect(saved.statusCode).toBe(422);
    expect(saved.json().message).toBe("Didit is not available on this server.");
    await enable("didit");
    const start = await live.inject({
      method: "POST", url: "/api/idv/start-check", cookies: teller, payload: { tier: "3" },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json().message).toBe("Didit is not available on this server.");
    const hook = await live.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: FIXTURE.toString("utf8"),
      headers: headers(FIXTURE, Math.floor(Date.now() / 1000)),
    });
    expect(hook.statusCode).toBe(503);
    expect(hook.json()).toEqual({ error: "not_available" });
  });

  it("stores one event per session and status and drops the decision", async () => {
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    await enable("didit");
    await handle.db.execute(sql`
      INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
      VALUES ('cli-didit', ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Didit Fixture')
      ON CONFLICT (client_id) DO NOTHING
    `);
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier)
      VALUES ('ref-didit-1', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${SESSION}, 'cli-didit', '3')
      ON CONFLICT (reference_id) DO NOTHING
    `);
    const seconds = Math.floor(Date.now() / 1000);
    const first = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: FIXTURE.toString("utf8"),
      headers: headers(FIXTURE, seconds),
    });
    const again = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: FIXTURE.toString("utf8"),
      headers: headers(FIXTURE, seconds),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ received: true, duplicate: false });
    expect(again.json()).toEqual({ received: true, duplicate: true });
    expect(first.body).not.toContain("Fixture Person");
    expect(first.body).not.toContain(SECRET);
    const events = await handle.db.execute(sql`SELECT event_id FROM idv_events WHERE provider_ref = ${SESSION}`);
    expect(events.rows).toHaveLength(1);
    const record = await handle.db.execute(sql`
      SELECT name_on_id, provider, result, document_number_ciphertext FROM idv_check_records WHERE persona_inquiry_id = ${SESSION}
    `);
    expect(record.rows[0]).toMatchObject({
      name_on_id: null, provider: "didit", result: "pass", document_number_ciphertext: null,
    });
    expect(JSON.stringify(record.rows)).not.toContain("FIXTURE0001");
    const file = await app.inject({
      method: "GET", url: "/api/idv/clients/cli-didit/checks", cookies: cookies.teller,
    });
    expect(file.statusCode, file.body).toBe(200);
    const shown = file.json() as { standing: { chip: string }; records: Array<{ statusLine: string }> };
    expect(shown.standing.chip).toBe("Missing ID");
    expect(shown.records[0]?.statusLine).toContain("ID checked");
    expect(shown.records[0]?.statusLine).not.toBe("Missing ID");
    expect(file.body).not.toContain("ID verified, scan and selfie");
    const audited = await handle.db.execute(sql`
      SELECT action, detail::text AS detail FROM audit_events
       WHERE action = 'idv.didit_result' AND detail->>'referenceId' = 'ref-didit-1'
    `);
    expect(audited.rows).toHaveLength(1);
    expect(JSON.stringify(audited.rows)).not.toContain("Fixture Person");
    expect(JSON.stringify(audited.rows)).not.toContain(SECRET);
    expect(JSON.stringify(audited.rows)).not.toContain("FIXTURE0001");
  });

  it("does not record a pass when a later Approved status is skipped", async () => {
    const session = "33333333-4444-4555-8666-777777777777";
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier, status)
      VALUES ('ref-declined', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${session}, 'cli-didit', '3', 'declined')
    `);
    const raw = Buffer.from(JSON.stringify({
      webhook_type: "status.updated",
      session_id: session,
      status: "Approved",
      vendor_data: "ref-declined",
      decision: {
        id_verifications: [{ status: "Approved" }],
        liveness_checks: [{ status: "Approved" }],
        face_matches: [{ status: "Approved" }],
      },
    }));
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: headers(raw, Math.floor(Date.now() / 1000)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await handle.db.execute(sql`SELECT result FROM idv_check_records WHERE persona_inquiry_id = ${session}`);
    expect(rows.rows).toEqual([]);
    const status = await handle.db.execute(sql`SELECT status FROM idv_inquiries WHERE provider_ref = ${session}`);
    expect(status.rows[0]).toMatchObject({ status: "declined" });
  });

  it("passes only when ID, liveness, and face match each passed", async () => {
    const session = "55555555-6666-4777-8888-999999999999";
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier, status)
      VALUES ('ref-face', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${session}, 'cli-didit', '4', 'starting')
    `);
    const raw = Buffer.from(JSON.stringify({
      webhook_type: "status.updated",
      session_id: session,
      status: "Approved",
      vendor_data: "ref-face",
      decision: {
        full_name: "Fixture Person",
        id_verifications: [{ status: "Approved" }],
        liveness_checks: [{ status: "Approved" }],
        face_matches: [{ status: "Declined" }],
      },
    }));
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: headers(raw, Math.floor(Date.now() / 1000)),
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await handle.db.execute(sql`
      SELECT result, method, database_step, provider_checks FROM idv_check_records WHERE persona_inquiry_id = ${session}
    `);
    expect(row.rows[0]).toMatchObject({
      result: "method_not_completed",
      method: "id_and_selfie",
      database_step: "off",
      provider_checks: "ID passed, liveness passed, face match not passed",
    });
    expect(String(row.rows[0]?.provider_checks)).not.toContain("database");
    expect(String(row.rows[0]?.method)).not.toContain("database");
    expect(JSON.stringify(row.rows[0])).not.toContain("Fixture Person");
  });

  it("does not apply a webhook off a test shop or on live Render", async () => {
    const session = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier, status)
      VALUES ('ref-lock', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${session}, 'cli-didit', '3', 'starting')
    `);
    await handle.db.update(schema.tenants).set({ isTestShop: false }).where(eq(schema.tenants.id, DEMO.tenantId));
    const raw = Buffer.from(JSON.stringify({
      webhook_type: "status.updated",
      session_id: session,
      status: "Approved",
      vendor_data: "ref-lock",
      decision: {
        id_verifications: [{ status: "Approved" }],
        liveness_checks: [{ status: "Approved" }],
        face_matches: [{ status: "Approved" }],
      },
    }));
    const dropped = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: headers(raw, Math.floor(Date.now() / 1000)),
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(dropped.json()).toEqual({ received: true, dropped: true });
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    const parsed = parseDiditWebhook(JSON.parse(raw.toString("utf8")));
    expect(await finishDiditWebhook(handle.db, parsed!, RENDER_LIVE)).toBe("unknown");
    const rows = await handle.db.execute(sql`SELECT result FROM idv_check_records WHERE persona_inquiry_id = ${session}`);
    expect(rows.rows).toEqual([]);
    const status = await handle.db.execute(sql`SELECT status FROM idv_inquiries WHERE provider_ref = ${session}`);
    expect(status.rows[0]).toMatchObject({ status: "starting" });
    const refused = await handle.db.execute(sql`
      SELECT detail->>'reason' AS reason FROM audit_events
       WHERE action = 'idv.didit_webhook_refused' AND branch_id = ${DEMO.branchId}
       ORDER BY at DESC LIMIT 2
    `);
    expect(refused.rows.map((row) => row.reason).sort()).toEqual(["not_test_shop", "runtime_locked"]);
    await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'failed' WHERE provider_ref = ${session}`);
  });

  it("rejects a vendor_data value that is not the stored reference", async () => {
    const session = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    await handle.db.execute(sql`
      INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id, requested_tier, status)
      VALUES ('ref-stored', ${DEMO.legalEntityId}, ${DEMO.branchId}, 'm.costa', 'didit', ${session}, 'cli-didit', '3', 'starting')
    `);
    const raw = Buffer.from(JSON.stringify({
      webhook_type: "status.updated",
      session_id: session,
      status: "Declined",
      vendor_data: "ref-other",
    }));
    const res = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: headers(raw, Math.floor(Date.now() / 1000)),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_webhook" });
    const events = await handle.db.execute(sql`SELECT event_id FROM idv_events WHERE provider_ref = ${session}`);
    expect(events.rows).toEqual([]);
    const refused = await handle.db.execute(sql`
      SELECT detail->>'reason' AS reason FROM audit_events
       WHERE action = 'idv.didit_webhook_refused'
       ORDER BY at DESC LIMIT 1
    `);
    expect(refused.rows[0]).toMatchObject({ reason: "vendor_data_conflict" });
    expect(JSON.stringify(refused.rows)).not.toContain("ref-other");
    await handle.db.execute(sql`UPDATE idv_inquiries SET status = 'failed' WHERE provider_ref = ${session}`);
  });

  it("rejects a bad signature and a stale replay before any write", async () => {
    const before = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_events`);
    const raw = Buffer.from(JSON.stringify({
      webhook_type: "status.updated",
      session_id: "22222222-3333-4444-8555-666666666666",
      status: "Declined",
      vendor_data: "ref-didit-1",
      decision: { full_name: "Fixture Person" },
    }));
    const bad = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: { "content-type": "application/json", "x-timestamp": String(Math.floor(Date.now() / 1000)), "x-signature": "ab".repeat(32) },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid_signature" });
    const stale = await app.inject({
      method: "POST", url: "/api/webhooks/idv/didit", payload: raw.toString("utf8"),
      headers: headers(raw, Math.floor(Date.now() / 1000) - 301),
    });
    expect(stale.statusCode).toBe(401);
    const after = await handle.db.execute(sql`SELECT count(*)::int AS n FROM idv_events`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("starts tier 3 on a test shop and refuses tier 4", async () => {
    calls.length = 0;
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    await enable("didit");
    const plus = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { tier: "4", clientId: "cli-didit" },
    });
    expect(plus.statusCode).toBe(409);
    expect(plus.json()).toMatchObject({ code: "IDV_TIER", message: "not available yet" });
    expect(plus.body).not.toContain("ID, selfie and database");
    expect(calls).toHaveLength(0);
    const started = await app.inject({
      method: "POST", url: "/api/idv/start-check", cookies: cookies.teller, payload: { tier: "3", clientId: "cli-didit" },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().providerRef).toMatch(/^44444444-5555-4666-8777-/);
    expect(started.json().method).toBe("ID and selfie");
    expect(JSON.stringify(started.json())).not.toContain("Fixture Person");
    const saved = await app.inject({
      method: "PUT", url: "/api/settings/idv", cookies: cookies.owner,
      payload: { provider: "didit", checksEnabled: true },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().provider).toBe("didit");
    expect(saved.json().diditSelectable).toBe(true);
    expect(saved.json().tier4).toBe("unavailable");
  });
});
