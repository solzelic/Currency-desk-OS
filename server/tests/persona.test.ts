/* Persona stays disconnected until both secrets are set.
   Payloads are recorded here. Nothing in this file opens a socket. */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { createPersonaInquiry, parsePersonaEvent, PersonaRequestError, verifyPersonaSignature } from "../src/kyc/persona.js";

let handle: DbHandle;
let app: FastifyInstance;
const secret = "whsec_persona_test";
const clientId = "cli_11111111-1111-4111-8111-111111111111";
const plantedName = "ZZ-PERSONA-SECRET-NAME";
const plantedDocument = "DL-SECRET-9912";

const sessionCookie = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const cookie = res.cookies.find((item) => item.name === "cdos_session");
  return cookie ? { cdos_session: cookie.value } : {};
};

function sign(payload: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

function eventBody(eventId: string, reference: string | null, eventName = "inquiry.approved"): string {
  return JSON.stringify({
    data: {
      type: "event",
      id: eventId,
      attributes: {
        name: eventName,
        payload: {
          data: {
            type: "inquiry",
            id: "inq_recorded_1",
            attributes: {
              status: "approved",
              "reference-id": reference,
              "name-first": plantedName,
            },
          },
          included: [{
            type: "verification/government-id",
            attributes: { "identification-number": plantedDocument, "name-first": plantedName },
          }],
        },
      },
    },
  });
}

async function postWebhook(payload: string, signature: string | undefined) {
  return app.inject({
    method: "POST",
    url: "/api/webhooks/persona",
    payload,
    headers: {
      "content-type": "application/json",
      ...(signature ? { "persona-signature": signature } : {}),
    },
  });
}

beforeAll(async () => {
  delete process.env.PERSONA_API_KEY;
  delete process.env.PERSONA_WEBHOOK_SECRET;
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.execute(sql`
    INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name, created_by, updated_by)
    VALUES (${clientId}, ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Ada Tester', 'test', 'test')`);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  delete process.env.PERSONA_API_KEY;
  delete process.env.PERSONA_WEBHOOK_SECRET;
});

describe("Persona disconnected", () => {
  it("tells a signed-in desk that ID checks are not connected", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "a.singh", password: DEMO.password } });
    const res = await app.inject({ method: "GET", url: "/api/kyc/persona", cookies: sessionCookie(login) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, message: "ID checks not connected yet" });
  });

  it("does not accept a webhook", async () => {
    const payload = eventBody("evt_disconnected", clientId);
    const res = await postWebhook(payload, sign(payload));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "not_connected", message: "ID checks not connected yet" });
    const rows = await handle.db.select().from(schema.personaInquiryEvents);
    expect(rows).toHaveLength(0);
  });
});

describe("Persona client and webhook", () => {
  beforeAll(() => {
    process.env.PERSONA_API_KEY = "persona_sandbox_test";
    process.env.PERSONA_WEBHOOK_SECRET = secret;
  });

  it("rejects a missing or stale signature", async () => {
    const payload = eventBody("evt_unsigned", clientId);
    expect((await postWebhook(payload, undefined)).statusCode).toBe(400);
    expect((await postWebhook(payload, "t=1,v1=abcd")).statusCode).toBe(400);
    const stale = sign(payload, Math.floor(Date.now() / 1000) - 60 * 60);
    const rejected = await postWebhook(payload, stale);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "invalid_signature" });
  });

  it("stores an approved inquiry once, linked to the client, without the name or the document", async () => {
    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const network = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("persona test refused the network"); };
    try {
      const payload = eventBody("evt_approved", clientId);
      const res = await postWebhook(payload, sign(payload));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, duplicate: false });
      const again = await postWebhook(payload, sign(payload));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ received: true, duplicate: true });
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
      globalThis.fetch = network;
    }

    const rows = await handle.db.select().from(schema.personaInquiryEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: "evt_approved",
      inquiryId: "inq_recorded_1",
      eventName: "inquiry.approved",
      status: "approved",
      clientId,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      environment: "sandbox",
    });
    const audits = await handle.db.select().from(schema.auditEvents);
    const recorded = audits.filter((row) => row.action === "kyc.persona.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.detail).toEqual({
      eventId: "evt_approved",
      inquiryId: "inq_recorded_1",
      status: "approved",
      clientId,
    });
    const standing = await handle.db.execute(sql`
      SELECT verification_status FROM desk_clients WHERE client_id = ${clientId}`);
    expect((standing.rows[0] as { verification_status: string }).verification_status).toBe("unverified");
    const dumped = JSON.stringify({ rows, audits: recorded, logged });
    expect(dumped).not.toContain(plantedName);
    expect(dumped).not.toContain(plantedDocument);
  });

  it("drops a reference that is not a client id and does not store it", async () => {
    const payload = eventBody("evt_named", plantedName);
    const res = await postWebhook(payload, sign(payload));
    expect(res.statusCode).toBe(200);
    const rows = await handle.db.select().from(schema.personaInquiryEvents);
    const named = rows.find((row) => row.eventId === "evt_named");
    expect(named?.clientId).toBeNull();
    expect(JSON.stringify(named)).not.toContain(plantedName);
    expect(JSON.stringify(named)).not.toContain(plantedDocument);
  });

  it("acknowledges an event it does not store", async () => {
    const payload = eventBody("evt_other", clientId, "inquiry.transitioned");
    const res = await postWebhook(payload, sign(payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    const rows = await handle.db.select().from(schema.personaInquiryEvents);
    expect(rows.some((row) => row.eventId === "evt_other")).toBe(false);
  });

  it("builds an inquiry from a recorded response and does not call fetch itself", async () => {
    let called = "";
    let authorization = "";
    const created = await createPersonaInquiry({
      config: {
        apiKey: "persona_sandbox_test",
        webhookSecret: secret,
        environment: "sandbox",
        apiBase: "https://api.withpersona.com",
      },
      templateId: "itmpl_recorded",
      referenceId: clientId,
      fetchImpl: async (url, init) => {
        called = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        const body = JSON.parse(String(init?.body));
        expect(body.data.attributes["reference-id"]).toBe(clientId);
        expect(body.data.attributes["inquiry-template-id"]).toBe("itmpl_recorded");
        expect(JSON.stringify(body)).not.toContain(plantedName);
        return new Response(JSON.stringify({ data: { id: "inq_from_recorded", attributes: { "name-first": plantedName } } }), { status: 201 });
      },
    });
    expect(called).toBe("https://api.withpersona.com/api/v1/inquiries");
    expect(authorization).toBe("Bearer persona_sandbox_test");
    expect(created).toEqual({ inquiryId: "inq_from_recorded" });
  });

  it("reports a provider refusal without the response body", async () => {
    await expect(createPersonaInquiry({
      config: {
        apiKey: "persona_sandbox_test",
        webhookSecret: secret,
        environment: "sandbox",
        apiBase: "https://api.withpersona.com",
      },
      templateId: "itmpl_recorded",
      referenceId: clientId,
      fetchImpl: async () => new Response(JSON.stringify({ errors: [{ detail: plantedName }] }), { status: 422 }),
    })).rejects.toMatchObject({ name: "PersonaRequestError", status: 422 });
    try {
      await createPersonaInquiry({
        config: {
          apiKey: "persona_sandbox_test",
          webhookSecret: secret,
          environment: "sandbox",
          apiBase: "https://api.withpersona.com",
        },
        templateId: "itmpl_recorded",
        referenceId: clientId,
        fetchImpl: async () => new Response(JSON.stringify({ errors: [{ detail: plantedName }] }), { status: 422 }),
      });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaRequestError);
      expect(err instanceof Error ? err.message : "").not.toContain(plantedName);
    }
  });

  it("treats a timeout as a refusal", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    await expect(createPersonaInquiry({
      config: {
        apiKey: "persona_sandbox_test",
        webhookSecret: secret,
        environment: "sandbox",
        apiBase: "https://api.withpersona.com",
      },
      templateId: "itmpl_recorded",
      referenceId: clientId,
      fetchImpl: async () => { throw timeout; },
    })).rejects.toMatchObject({ status: 504 });
  });

  it("verifies the signature the webhook uses", () => {
    const payload = Buffer.from("{\"data\":{}}");
    const timestamp = "1700000000";
    const mac = createHmac("sha256", secret).update(`${timestamp}.${payload.toString("utf8")}`).digest("hex");
    expect(verifyPersonaSignature({
      rawBody: payload,
      signature: `t=${timestamp},v1=${mac}`,
      secret,
      now: 1_700_000_000_000,
    })).toBe(true);
    expect(parsePersonaEvent({ data: { id: "not-an-event" } })).toBeNull();
  });
});
