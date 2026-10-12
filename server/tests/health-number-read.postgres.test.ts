/* A stored health number must not leave the server on any read.

   The row stays. The clients API — one client, the list, and name
   lookup — returns the type, the issuing province when one was stored,
   the expiry, and the date recorded. The number is not a field and not
   a value anywhere in that JSON. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { HEALTH_CARD_NAMES, HEALTH_CARD_REFUSAL } from "../src/clients/health-card.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const OHIP_NUMBER = "HN-9F3C-77A1-PRIV";
const CARD_NUMBER = "HN-2B70-RAMQ-PRIV";
const PASSPORT_NUMBER = "PA-HEALTH-CONTROL";

const NUMBER_KEYS = new Set(["docNumber", "doc_number", "idNum", "num", "number"]);

function scan(value: unknown, path: string, secrets: string[], hits: string[]) {
  if (typeof value === "string") {
    for (const secret of secrets) {
      if (value.includes(secret)) hits.push(`${path} contains ${secret}`);
    }
    return;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}[${index}]`, secrets, hits));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (NUMBER_KEYS.has(key)) hits.push(`${path}.${key} is a number field`);
      scan(child, `${path}.${key}`, secrets, hits);
    }
  }
}

function expectNoHealthNumber(body: unknown, secrets: string[]) {
  const hits: string[] = [];
  scan(body, "$", secrets, hits);
  expect(hits, hits.join("\n")).toEqual([]);
}

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let cookies: Record<string, string>;
const created: string[] = [];

async function login() {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "j.masri", password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((item) => item.name === "cdos_session");
  if (!session) throw new Error("desk sign-in did not set a session");
  cookies = { cdos_session: session.value };
}

postgres("a health card number is not on a read", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    await login();
  });

  afterAll(async () => {
    if (created.length) {
      await pool.query("DELETE FROM desk_clients WHERE client_id = ANY($1::text[])", [created]);
    }
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  async function plant(
    clientId: string,
    docType: string,
    docNumber: string,
    primary: boolean,
    expiresOn = "2030-04-01",
    jurisdiction: string | null = "ON",
  ) {
    const owner = await pool.query<{ tenant_id: string; legal_entity_id: string }>(
      "SELECT tenant_id, legal_entity_id FROM desk_clients WHERE client_id=$1",
      [clientId],
    );
    const row = owner.rows[0];
    if (!row) throw new Error(`no client ${clientId}`);
    await pool.query(
      `INSERT INTO desk_client_identity_documents
        (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number,
         issuing_jurisdiction, expires_on, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'test')`,
      [`doc_${randomUUID()}`, clientId, row.tenant_id, row.legal_entity_id, docType, docNumber, jurisdiction, expiresOn, primary],
    );
  }

  it("refuses a new health card and still omits a number that is already stored", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      payload: { legalName: "Health Read Ohip" },
    });
    expect(made.statusCode).toBe(201);
    const clientId = made.json().clientId as string;
    created.push(clientId);

    const refused = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: {
        docType: "Ontario Health Insurance Plan",
        docNumber: OHIP_NUMBER,
        issuingJurisdiction: "ON",
        expiresOn: "2030-04-01",
        isPrimary: true,
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "HEALTH_CARD_NOT_ID", message: HEALTH_CARD_REFUSAL });

    await plant(clientId, "OHIP", OHIP_NUMBER, true);
    await plant(clientId, "Health   Card", CARD_NUMBER, false, "2031-01-15", null);

    const primary = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });
    expect(primary.statusCode).toBe(200);
    expectNoHealthNumber(primary.json(), [OHIP_NUMBER, CARD_NUMBER]);

    const one = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });
    expect(one.statusCode).toBe(200);
    const body = one.json();
    expectNoHealthNumber(body, [OHIP_NUMBER, CARD_NUMBER]);

    const documents = body.documents as Record<string, unknown>[];
    const ohip = documents.find((document) => document.docType === "OHIP");
    const card = documents.find((document) => document.docType === "Health   Card");
    expect(ohip).toMatchObject({
      docType: "OHIP",
      issuingJurisdiction: "ON",
      expiresOn: "2030-04-01",
      isPrimary: true,
    });
    expect(ohip?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card).toMatchObject({ docType: "Health   Card", expiresOn: "2031-01-15", isPrimary: false });
    expect(card).not.toHaveProperty("issuingJurisdiction");
    expect(card?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const list = await app.inject({ method: "GET", url: "/api/clients", cookies });
    expect(list.statusCode).toBe(200);
    const listed = (list.json().clients as { clientId: string }[]).find((client) => client.clientId === clientId);
    expect(listed).toBeTruthy();
    expectNoHealthNumber(listed, [OHIP_NUMBER, CARD_NUMBER]);

    const lookup = await app.inject({
      method: "GET",
      url: "/api/clients/lookup?name=Health%20Read%20Ohip",
      cookies,
    });
    expect(lookup.statusCode).toBe(200);
    const found = (lookup.json().clients as { clientId: string }[]).find((client) => client.clientId === clientId);
    expect(found).toBeTruthy();
    expectNoHealthNumber(found, [OHIP_NUMBER, CARD_NUMBER]);

    const stored = await pool.query(
      "SELECT doc_type, doc_number, issuing_jurisdiction, expires_on::text FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY is_primary DESC",
      [clientId],
    );
    expect(stored.rows).toEqual([
      { doc_type: "OHIP", doc_number: OHIP_NUMBER, issuing_jurisdiction: "ON", expires_on: "2030-04-01" },
      { doc_type: "Health   Card", doc_number: CARD_NUMBER, issuing_jurisdiction: null, expires_on: "2031-01-15" },
    ]);
  });

  it("still returns a passport number", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      payload: { legalName: "Health Read Passport" },
    });
    expect(made.statusCode).toBe(201);
    const clientId = made.json().clientId as string;
    created.push(clientId);
    const added = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: { docType: "Passport", docNumber: PASSPORT_NUMBER, isPrimary: true },
    });
    expect(added.statusCode).toBe(201);
    const document = (added.json().documents as { docType: string; docNumber?: string }[])
      .find((row) => row.docType === "Passport");
    expect(document?.docNumber).toBe(PASSPORT_NUMBER);
  });

  it("runs the shared name list through the clients API and does not identify a health card", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      payload: { legalName: "Health Read Table" },
    });
    expect(made.statusCode).toBe(201);
    const clientId = made.json().clientId as string;
    created.push(clientId);
    const secrets = HEALTH_CARD_NAMES.map((name, index) => `${name}::HN-TABLE-${index}-PRIV`);
    for (let i = 0; i < HEALTH_CARD_NAMES.length; i++) {
      await plant(clientId, HEALTH_CARD_NAMES[i]!, secrets[i]!, i === 0);
    }
    await pool.query("UPDATE desk_clients SET verification_status='identified' WHERE client_id=$1", [clientId]);

    const one = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });
    expect(one.statusCode).toBe(200);
    const body = one.json();
    expectNoHealthNumber(body, secrets);
    expect(body.verificationStatus).toBe("unverified");
    expect(body.documents).toHaveLength(HEALTH_CARD_NAMES.length);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/clients/${clientId}/documents/${body.documents[0].documentId}`,
      cookies,
      payload: { docNumber: "HN-PATCH-PRIV" },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().code).toBe("HEALTH_CARD_NOT_ID");

    const passport = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: { docType: "Passport", docNumber: PASSPORT_NUMBER, expiresOn: "2031-01-01", isPrimary: true },
    });
    expect(passport.statusCode).toBe(201);
    expect(passport.json().verificationStatus).toBe("identified");
    const passportId = (passport.json().documents as { docType: string; documentId: string }[])
      .find((row) => row.docType === "Passport")!.documentId;
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/clients/${clientId}/documents/${passportId}`,
      cookies,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().verificationStatus).toBe("unverified");
    expectNoHealthNumber(removed.json(), secrets);

    await pool.query("UPDATE desk_clients SET verification_status='verified' WHERE client_id=$1", [clientId]);
    const kept = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies });
    expect(kept.json().verificationStatus).toBe("verified");
    expectNoHealthNumber(kept.json(), secrets);
  });

  it("scrubs a health number on tenant-state save, read, conflict, and a teller read", async () => {
    const secret = "HN-TENANT-STATE-PRIV";
    const before = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
    expect(before.statusCode).toBe(200);
    const prior = before.json() as { state: Record<string, unknown> | null; version: number };
    const incoming = {
      ...(prior.state ?? {}),
      cdos_clients_v1: {
        "Hana Health": {
          idType: "BC Services Card",
          idNum: secret,
          ids: [{ type: "Carte d'assurance maladie", num: secret }],
        },
      },
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/tenant/state",
      cookies,
      payload: { state: incoming, version: prior.version },
    });
    expect(saved.statusCode).toBe(200);
    const stored = await pool.query("SELECT state::text AS state, version FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    expect(stored.rows[0]!.state).not.toContain(secret);

    await pool.query(
      `UPDATE tenant_state
          SET state = jsonb_set(state, '{cdos_clients_v1,Planted}', $2::jsonb, true)
        WHERE tenant_id=$1`,
      [DEMO.tenantId, JSON.stringify({ idType: "OHIP", idNum: secret })],
    );
    const read = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
    expect(read.statusCode).toBe(200);
    expect(JSON.stringify(read.json())).not.toContain(secret);
    const version = read.json().version as number;

    const conflict = await app.inject({
      method: "PUT",
      url: "/api/tenant/state",
      cookies,
      payload: {
        version: version === 0 ? 1 : 0,
        state: { cdos_clients_v1: { "Old Tab": { idType: "Medicare card", idNum: secret } } },
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.stringify(conflict.json())).not.toContain(secret);

    const teller = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(teller.statusCode).toBe(200);
    const tellerCookie = teller.cookies.find((item) => item.name === "cdos_session");
    if (!tellerCookie) throw new Error("teller sign-in did not set a session");
    const tellerRead = await app.inject({
      method: "GET",
      url: "/api/tenant/state",
      cookies: { cdos_session: tellerCookie.value },
    });
    expect(tellerRead.statusCode).toBe(200);
    expect(JSON.stringify(tellerRead.json())).not.toContain(secret);

    if (prior.state) {
      await pool.query("UPDATE tenant_state SET state=$2::jsonb, version=$3 WHERE tenant_id=$1", [
        DEMO.tenantId,
        JSON.stringify(prior.state),
        prior.version,
      ]);
    }
  });
});
