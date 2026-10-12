/* A stored health number must not leave the server on any read.

   The row stays. The clients API — one client, the list, and name
   lookup — returns the type, the issuing province when one was stored,
   the expiry, and the date recorded. The number is not a field and not
   a value anywhere in that JSON. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

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

  it("returns type, province, expiry and the date recorded, and no number anywhere", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      payload: { legalName: "Health Read Ohip" },
    });
    expect(made.statusCode).toBe(201);
    const clientId = made.json().clientId as string;
    created.push(clientId);

    const primary = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: {
        docType: "OHIP",
        docNumber: OHIP_NUMBER,
        issuingJurisdiction: "ON",
        expiresOn: "2030-04-01",
        isPrimary: true,
      },
    });
    expect(primary.statusCode).toBe(201);
    expectNoHealthNumber(primary.json(), [OHIP_NUMBER]);

    const extra = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: {
        docType: "Health   Card",
        docNumber: CARD_NUMBER,
        expiresOn: "2031-01-15",
        isPrimary: false,
      },
    });
    expect(extra.statusCode).toBe(201);
    expectNoHealthNumber(extra.json(), [OHIP_NUMBER, CARD_NUMBER]);

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
});
