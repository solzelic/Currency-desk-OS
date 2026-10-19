/* Persona stays disconnected until both secrets are set. A signed
   delivery is stored once, linked to the client file, and audited, and
   nothing that names the person reaches a row, an audit, or a log.
   Payloads are recorded here. Nothing in this file opens a socket. */
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { isAcceptedIdType } from "../src/clients/id-document-types.js";
import {
  MAX_SIGNATURE_AGE_MS,
  catalogueCodeFor,
  createPersonaInquiry,
  idTypeOf,
  parsePersonaEvent,
  personaConfig,
  PersonaRequestError,
  verifyPersonaSignature,
} from "../src/kyc/persona.js";

let handle: DbHandle;
let app: FastifyInstance;
const appLog: string[] = [];
const secret = "wbhsec_persona_test";
const clientId = "cli_11111111-1111-4111-8111-111111111111";
const absentClientId = "cli_22222222-2222-4222-8222-222222222222";
const plantedName = "ZZ-PERSONA-SECRET-NAME";
const plantedDocument = "DL-SECRET-9912";
const plantedHealthNumber = "1234-567-890-HN";
const plantedBirthdate = "1961-02-03";
const plantedAddress = "77 Secret Lane";

/* Every class in Persona's government-ID table, as of 2026-10. */
const PERSONA_ID_CLASSES = [
  "cct", "cid", "dl", "foid", "hic", "id", "ipp", "keyp", "ltpass", "munid", "myn", "nbi", "nric",
  "ofw", "rp", "pan", "pid", "pp", "ppc", "pr", "sss", "td", "tribalid", "umid", "vid", "visa", "wp",
];

const now = () => Math.floor(Date.now() / 1000);

function mac(payload: string, timestamp: number, key = secret): string {
  return createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("hex");
}

function sign(payload: string, timestamp = now(), key = secret): string {
  return `t=${timestamp},v1=${mac(payload, timestamp, key)}`;
}

function governmentId(idClass: string, status = "passed", number = plantedDocument) {
  return {
    type: "verification/government-id",
    id: `ver_${idClass}_${status}`,
    attributes: {
      status,
      "id-class": idClass,
      "identification-number": number,
      "name-first": plantedName,
      birthdate: plantedBirthdate,
      "address-street-1": plantedAddress,
    },
  };
}

function eventBody(
  eventId: string,
  reference: string | null,
  opts: { eventName?: string; status?: string; included?: unknown[] } = {},
): string {
  return JSON.stringify({
    data: {
      type: "event",
      id: eventId,
      attributes: {
        name: opts.eventName ?? "inquiry.approved",
        "created-at": "2026-10-19T12:00:00.000Z",
        payload: {
          data: {
            type: "inquiry",
            id: `inq_${eventId.slice(4)}`,
            attributes: {
              status: opts.status ?? "approved",
              "reference-id": reference,
              "name-first": plantedName,
              birthdate: plantedBirthdate,
              "address-street-1": plantedAddress,
              "identification-number": plantedDocument,
            },
          },
          included: opts.included ?? [governmentId("dl")],
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

async function rows() {
  return handle.db.select().from(schema.personaInquiryEvents);
}

async function personaAudits() {
  return (await handle.db.select().from(schema.auditEvents)).filter((row) => row.action === "kyc.persona.recorded");
}

let deskCookie: Record<string, string> = {};

function connect(): void {
  process.env.PERSONA_API_KEY = "persona_sandbox_test";
  process.env.PERSONA_WEBHOOK_SECRET = secret;
}

function disconnect(): void {
  delete process.env.PERSONA_API_KEY;
  delete process.env.PERSONA_WEBHOOK_SECRET;
  delete process.env.PERSONA_TEMPLATE_ID;
}

beforeAll(async () => {
  disconnect();
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db.execute(sql`
    INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name, created_by, updated_by)
    VALUES (${clientId}, ${DEMO.tenantId}, ${DEMO.legalEntityId}, 'Ada Tester', 'test', 'test')`);
  const sink = new Writable({
    write(chunk, _encoding, done) {
      appLog.push(String(chunk));
      done();
    },
  });
  app = await buildApp(handle.db, {}, sink);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((item) => item.name === "cdos_session");
  deskCookie = cookie ? { cdos_session: cookie.value } : {};
});

afterAll(async () => {
  await app.close();
  await handle.close();
  disconnect();
});

describe("the signature check", () => {
  const body = Buffer.from("{\"data\":{\"id\":\"evt_sig\"}}");
  const at = 1_700_000_000;
  const nowMs = at * 1000;

  it("accepts a good signature", () => {
    expect(verifyPersonaSignature({ rawBody: body, signature: sign(body.toString(), at), secret, now: nowMs })).toBe(true);
  });

  it("refuses a signature made with another secret", () => {
    expect(verifyPersonaSignature({ rawBody: body, signature: sign(body.toString(), at, "wbhsec_other"), secret, now: nowMs })).toBe(false);
  });

  it("refuses a body changed after signing", () => {
    const signature = sign(body.toString(), at);
    const changed = Buffer.from("{\"data\":{\"id\":\"evt_sigX\"}}");
    expect(verifyPersonaSignature({ rawBody: changed, signature, secret, now: nowMs })).toBe(false);
  });

  it("refuses a timestamp changed after signing", () => {
    const v1 = mac(body.toString(), at);
    expect(verifyPersonaSignature({ rawBody: body, signature: `t=${at + 1},v1=${v1}`, secret, now: nowMs })).toBe(false);
  });

  it("refuses a stale or future signature, and accepts one inside five minutes", () => {
    const signature = sign(body.toString(), at);
    expect(verifyPersonaSignature({ rawBody: body, signature, secret, now: nowMs + MAX_SIGNATURE_AGE_MS })).toBe(true);
    expect(verifyPersonaSignature({ rawBody: body, signature, secret, now: nowMs + MAX_SIGNATURE_AGE_MS + 1000 })).toBe(false);
    expect(verifyPersonaSignature({ rawBody: body, signature, secret, now: nowMs - MAX_SIGNATURE_AGE_MS - 1000 })).toBe(false);
  });

  it("refuses a malformed header", () => {
    const v1 = mac(body.toString(), at);
    for (const header of ["", `v1=${v1}`, `t=${at}`, `t=abc,v1=${v1}`, `t=${at},v1=zz`, `t=${at},t=${at},v1=${v1}`, `t=${at},v0=${v1}`]) {
      expect(verifyPersonaSignature({ rawBody: body, signature: header, secret, now: nowMs })).toBe(false);
    }
  });

  it("accepts either set while a secret is being rotated", () => {
    const old = sign(body.toString(), at, "wbhsec_old");
    const current = sign(body.toString(), at, secret);
    expect(verifyPersonaSignature({ rawBody: body, signature: `${old} ${current}`, secret, now: nowMs })).toBe(true);
    expect(verifyPersonaSignature({ rawBody: body, signature: `${current} ${old}`, secret, now: nowMs })).toBe(true);
    expect(verifyPersonaSignature({ rawBody: body, signature: `${old} ${old}`, secret, now: nowMs })).toBe(false);
  });

  it("signs the raw bytes, not a re-serialised body", () => {
    const spaced = Buffer.from("{ \"data\" : { \"id\" : \"evt_sig\", \"n\": 1.10 } }");
    const signature = sign(spaced.toString(), at);
    expect(verifyPersonaSignature({ rawBody: spaced, signature, secret, now: nowMs })).toBe(true);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(spaced.toString())));
    expect(verifyPersonaSignature({ rawBody: reserialised, signature, secret, now: nowMs })).toBe(false);
  });
});

describe("not connected until both secrets are set", () => {
  beforeEach(disconnect);

  it("reads no config with either secret missing or blank", () => {
    expect(personaConfig({})).toBeNull();
    expect(personaConfig({ PERSONA_API_KEY: "persona_sandbox_x" })).toBeNull();
    expect(personaConfig({ PERSONA_WEBHOOK_SECRET: secret })).toBeNull();
    expect(personaConfig({ PERSONA_API_KEY: "  ", PERSONA_WEBHOOK_SECRET: secret })).toBeNull();
    expect(personaConfig({ PERSONA_API_KEY: "persona_sandbox_x", PERSONA_WEBHOOK_SECRET: " " })).toBeNull();
    expect(personaConfig({ PERSONA_API_KEY: "persona_sandbox_x", PERSONA_WEBHOOK_SECRET: secret })).toMatchObject({
      environment: "sandbox",
      templateId: null,
    });
    expect(personaConfig({
      PERSONA_API_KEY: "persona_production_x",
      PERSONA_WEBHOOK_SECRET: secret,
      PERSONA_TEMPLATE_ID: "itmpl_abc123",
    })).toMatchObject({ environment: "live", templateId: "itmpl_abc123" });
  });

  it("asks for a session before saying anything", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kyc/persona" });
    expect(res.statusCode).toBe(401);
  });

  it("tells a signed-in desk that Persona is not connected", async () => {
    for (const half of [{}, { PERSONA_API_KEY: "persona_sandbox_test" }, { PERSONA_WEBHOOK_SECRET: secret }]) {
      disconnect();
      Object.assign(process.env, half);
      const res = await app.inject({ method: "GET", url: "/api/kyc/persona", cookies: deskCookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ connected: false, message: "Persona is not connected yet." });
    }
  });

  it("says connected, and which Persona environment, once both are set", async () => {
    connect();
    const res = await app.inject({ method: "GET", url: "/api/kyc/persona", cookies: deskCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, environment: "sandbox" });
    expect(JSON.stringify(res.json())).not.toContain("persona_sandbox_test");
    expect(JSON.stringify(res.json())).not.toContain(secret);
  });

  it("does not accept a webhook with either secret missing", async () => {
    const payload = eventBody("evt_disconnected", clientId);
    for (const half of [{}, { PERSONA_API_KEY: "persona_sandbox_test" }, { PERSONA_WEBHOOK_SECRET: secret }]) {
      disconnect();
      Object.assign(process.env, half);
      const res = await postWebhook(payload, sign(payload));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "not_connected", message: "Persona is not connected yet." });
    }
    expect(await rows()).toHaveLength(0);
  });
});

describe("the webhook", () => {
  beforeAll(connect);
  afterAll(disconnect);

  it("refuses a missing, bad, or stale signature and stores nothing", async () => {
    const payload = eventBody("evt_unsigned", clientId);
    expect((await postWebhook(payload, undefined)).statusCode).toBe(400);
    expect((await postWebhook(payload, "t=1,v1=abcd")).statusCode).toBe(400);
    expect((await postWebhook(payload, sign(payload, now(), "wbhsec_other"))).statusCode).toBe(400);
    expect((await postWebhook(payload.replace("approved", "declined"), sign(payload))).statusCode).toBe(400);
    const stale = await postWebhook(payload, sign(payload, now() - 60 * 60));
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toEqual({ error: "invalid_signature" });
    expect((await rows()).filter((row) => row.eventId === "evt_unsigned")).toHaveLength(0);
  });

  it("stores an approved inquiry once, linked to the client file, and audits it once", async () => {
    const before = await handle.db.execute(sql`SELECT count(*)::int AS n FROM desk_client_identity_documents WHERE client_id = ${clientId}`);
    const network = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("persona test refused the network"); };
    try {
      const payload = eventBody("evt_approved", clientId);
      const header = sign(payload);
      const res = await postWebhook(payload, header);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true, duplicate: false });
      /* The same bytes and header again: a captured delivery replayed
         inside the window. */
      const replay = await postWebhook(payload, header);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ received: true, duplicate: true });
      /* Persona's own retry, signed again later. */
      const retry = await postWebhook(payload, sign(payload, now() + 30));
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ received: true, duplicate: true });
      /* The captured delivery replayed after the window. */
      const late = await postWebhook(payload, sign(payload, now() - 10 * 60));
      expect(late.statusCode).toBe(400);
    } finally {
      globalThis.fetch = network;
    }

    const stored = (await rows()).filter((row) => row.eventId === "evt_approved");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      eventId: "evt_approved",
      inquiryId: "inq_approved",
      eventName: "inquiry.approved",
      status: "approved",
      idType: "drivers_licence",
      clientId,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      environment: "sandbox",
    });
    const recorded = (await personaAudits()).filter((row) => row.detail.eventId === "evt_approved");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, actorId: null });
    expect(recorded[0]?.detail).toEqual({
      eventId: "evt_approved",
      eventName: "inquiry.approved",
      inquiryId: "inq_approved",
      status: "approved",
      idType: "drivers_licence",
      clientId,
      environment: "sandbox",
    });

    /* The client file is not changed: no verified flag, no document. */
    const standing = await handle.db.execute(sql`SELECT verification_status FROM desk_clients WHERE client_id = ${clientId}`);
    expect((standing.rows[0] as { verification_status: string }).verification_status).toBe("unverified");
    const after = await handle.db.execute(sql`SELECT count(*)::int AS n FROM desk_client_identity_documents WHERE client_id = ${clientId}`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("stores Persona's needs-review as needs_review", async () => {
    const payload = eventBody("evt_review", clientId, { eventName: "inquiry.marked-for-review", status: "needs-review" });
    expect((await postWebhook(payload, sign(payload))).statusCode).toBe(200);
    const row = (await rows()).find((r) => r.eventId === "evt_review");
    expect(row?.status).toBe("needs_review");
  });

  it("never stores a health card, its number, or a type outside the catalogue", async () => {
    const payload = eventBody("evt_health", clientId, {
      included: [governmentId("hic", "passed", plantedHealthNumber)],
    });
    expect((await postWebhook(payload, sign(payload))).statusCode).toBe(200);
    const foreign = eventBody("evt_foreign", clientId, { included: [governmentId("myn")] });
    expect((await postWebhook(foreign, sign(foreign))).statusCode).toBe(200);
    const stored = (await rows()).filter((r) => r.eventId === "evt_health" || r.eventId === "evt_foreign");
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row.idType).toBeNull();
    const audits = (await personaAudits()).filter((r) => r.detail.eventId === "evt_health" || r.detail.eventId === "evt_foreign");
    for (const row of audits) expect(row.detail.idType).toBeNull();
    expect(JSON.stringify({ stored, audits })).not.toContain(plantedHealthNumber);
    expect(JSON.stringify({ stored, audits })).not.toContain("health_card");
  });

  it("refuses a health card at the database too", async () => {
    await expect(handle.db.execute(sql`
      INSERT INTO persona_inquiry_events (event_id, inquiry_id, event_name, status, id_type, environment)
      VALUES ('evt_direct_hc', 'inq_direct_hc', 'inquiry.approved', 'approved', 'health_card', 'sandbox')`)).rejects.toThrow();
  });

  it("keeps a reference that is not a client file off the row and off the audit", async () => {
    const named = eventBody("evt_named", plantedName);
    expect((await postWebhook(named, sign(named))).statusCode).toBe(200);
    const absent = eventBody("evt_absent", absentClientId);
    expect((await postWebhook(absent, sign(absent))).statusCode).toBe(200);
    const stored = (await rows()).filter((r) => r.eventId === "evt_named" || r.eventId === "evt_absent");
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.clientId).toBeNull();
      expect(row.tenantId).toBeNull();
    }
    const audits = (await personaAudits()).filter((r) => r.detail.eventId === "evt_named" || r.detail.eventId === "evt_absent");
    expect(audits).toHaveLength(0);
    expect(JSON.stringify(stored)).not.toContain(plantedName);
    expect(JSON.stringify(stored)).not.toContain(absentClientId);
  });

  it("acknowledges an event it does not store", async () => {
    const payload = eventBody("evt_other", clientId, { eventName: "inquiry.transitioned" });
    const res = await postWebhook(payload, sign(payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    expect((await rows()).some((row) => row.eventId === "evt_other")).toBe(false);
  });

  it("refuses a signed body that is not a Persona event", async () => {
    /* Fastify's own JSON reader refuses a body that is not JSON. */
    expect((await postWebhook("not json", sign("not json"))).statusCode).toBe(400);
    for (const payload of ["{}", JSON.stringify({ data: { id: "evt_x", attributes: { name: "inquiry.approved", payload: { data: { id: "bad" } } } } })]) {
      const res = await postWebhook(payload, sign(payload));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_webhook" });
    }
  });

  it("nothing sensitive is stored or logged", async () => {
    const stored = await rows();
    const audits = await personaAudits();
    const dumped = JSON.stringify({ stored, audits, appLog });
    for (const planted of [plantedName, plantedDocument, plantedHealthNumber, plantedBirthdate, plantedAddress, secret]) {
      expect(dumped).not.toContain(planted);
    }
    /* No column can hold one. */
    const columns = await handle.db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'persona_inquiry_events' ORDER BY column_name`);
    expect((columns.rows as { column_name: string }[]).map((r) => r.column_name)).toEqual([
      "client_id", "environment", "event_id", "event_name", "id_type", "inquiry_id", "legal_entity_id", "received_at", "status", "tenant_id",
    ]);
  });
});

describe("the ID type a Persona result may carry", () => {
  it("maps only to codes the catalogue accepts, and never to a health card", () => {
    for (const idClass of PERSONA_ID_CLASSES) {
      const code = catalogueCodeFor(idClass);
      if (code === null) continue;
      expect(isAcceptedIdType(code)).toBe(true);
      expect(code).not.toBe("health_card");
    }
    expect(catalogueCodeFor("hic")).toBeNull();
    expect(catalogueCodeFor("HIC")).toBeNull();
    expect(catalogueCodeFor("dl")).toBe("drivers_licence");
    expect(catalogueCodeFor("pp")).toBe("passport");
    expect(catalogueCodeFor("pr")).toBe("permanent_resident_card");
    expect(catalogueCodeFor("id")).toBeNull();
    expect(catalogueCodeFor("cct")).toBeNull();
  });

  it("reads only a passed government ID, and gives up when two disagree", () => {
    expect(idTypeOf([governmentId("pp")])).toBe("passport");
    expect(idTypeOf([governmentId("pp", "failed")])).toBeNull();
    expect(idTypeOf([governmentId("pp"), governmentId("dl")])).toBeNull();
    expect(idTypeOf([governmentId("pp"), governmentId("hic")])).toBeNull();
    expect(idTypeOf([{ type: "verification/selfie", attributes: { status: "passed" } }])).toBeNull();
    expect(idTypeOf(undefined)).toBeNull();
  });

  it("returns no field that names the person", () => {
    const event = parsePersonaEvent(JSON.parse(eventBody("evt_parse", clientId)));
    expect(event).not.toBeNull();
    expect(Object.keys(event as object).sort()).toEqual(["clientId", "eventId", "eventName", "idType", "inquiryId", "status"]);
    expect(JSON.stringify(event)).not.toContain(plantedName);
    expect(JSON.stringify(event)).not.toContain(plantedDocument);
    expect(parsePersonaEvent({ data: { id: "not-an-event" } })).toBeNull();
  });
});

describe("the inquiry request (not wired to a button yet)", () => {
  const config = {
    apiKey: "persona_sandbox_test",
    webhookSecret: secret,
    templateId: "itmpl_recorded",
    environment: "sandbox" as const,
    apiBase: "https://api.withpersona.com",
  };

  it("builds an inquiry from a recorded response", async () => {
    let called = "";
    let headers = new Headers();
    const created = await createPersonaInquiry({
      config,
      referenceId: clientId,
      fetchImpl: async (url, init) => {
        called = String(url);
        headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));
        expect(body.data.attributes["reference-id"]).toBe(clientId);
        expect(body.data.attributes["inquiry-template-id"]).toBe("itmpl_recorded");
        return new Response(JSON.stringify({ data: { id: "inq_from_recorded", attributes: { "name-first": plantedName } } }), { status: 201 });
      },
    });
    expect(called).toBe("https://api.withpersona.com/api/v1/inquiries");
    expect(headers.get("authorization")).toBe("Bearer persona_sandbox_test");
    expect(headers.get("persona-version")).toBe("2023-01-05");
    expect(created).toEqual({ inquiryId: "inq_from_recorded" });
  });

  it("refuses without a template or with a reference that is not a client id", async () => {
    const fetchImpl = async () => { throw new Error("must not be called"); };
    await expect(createPersonaInquiry({ config: { ...config, templateId: null }, referenceId: clientId, fetchImpl }))
      .rejects.toMatchObject({ status: 400 });
    await expect(createPersonaInquiry({ config, referenceId: plantedName, fetchImpl }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("reports a provider refusal without the response body", async () => {
    const refusal = async () => new Response(JSON.stringify({ errors: [{ detail: plantedName }] }), { status: 422 });
    try {
      await createPersonaInquiry({ config, referenceId: clientId, fetchImpl: refusal });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaRequestError);
      expect((err as PersonaRequestError).status).toBe(422);
      expect((err as Error).message).not.toContain(plantedName);
    }
  });

  it("treats a timeout as a refusal", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    await expect(createPersonaInquiry({ config, referenceId: clientId, fetchImpl: async () => { throw timeout; } }))
      .rejects.toMatchObject({ status: 504 });
  });
});
