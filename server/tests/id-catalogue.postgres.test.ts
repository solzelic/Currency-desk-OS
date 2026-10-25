/* ============================================================
   One ID-type catalogue, and no health numbers, against Postgres.

   What a desk can record is the catalogue (shared/id-document-types.js):
   a save with any other type is 422 ID_TYPE_NOT_IN_CATALOGUE, and a
   health card is 422 HEALTH_CARD_NOT_ID with the sentence the teller
   sees. A health number already stored is never in a read and never
   matched, the row itself still reads, and nothing here rewrites it.
   ============================================================ */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ClientRecordService } from "../src/clients/records.js";
import { notInCatalogueSentence, typeKey, typeKeySql } from "../src/clients/id-document-types.js";
import { idTypeRulesFor } from "../src/ledger/id-type-rules.js";
import type { LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const HEALTH_SENTENCE = "Health cards can't be used as ID. Record a current photo ID.";
const SHOP_LIST = notInCatalogueSentence(
  idTypeRulesFor("CA").filter((rule) => rule.packDefault).map((rule) => rule.label),
);

const TENANT = "tnt-idcat";
const ENTITY = "le-idcat";
const BRANCH = "br-idcat";
const TILL: LedgerActor = {
  userId: "u.idcat",
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: "ws-idcat-1",
  tillId: "till-1",
  role: "supervisor",
  authorizedBranchIds: [BRANCH],
};

/* Every key a health number could ride on, and every value it could be. */
const NUMBER_KEYS = new Set(["docNumber", "doc_number", "idNum", "num", "number"]);
function healthLeaks(value: unknown, secrets: string[], path = "$", hits: string[] = []): string[] {
  if (typeof value === "string") {
    for (const secret of secrets) if (value.includes(secret)) hits.push(`${path} holds ${secret}`);
    return hits;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => healthLeaks(item, secrets, `${path}[${i}]`, hits));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      healthLeaks(child, secrets, `${path}.${key}`, hits);
    }
  }
  return hits;
}

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let records: ClientRecordService;
let cookies: Record<string, string>;
const headers = { "x-workspace-id": DEMO.workspaceId };
const madeOverHttp: string[] = [];

async function signIn(staffId: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
}

async function openFile(legalName: string, kind: "individual" | "business" = "individual") {
  const res = await app.inject({ method: "POST", url: "/api/clients", cookies, headers, payload: { legalName, kind } });
  expect(res.statusCode, res.body).toBe(201);
  const clientId = res.json().clientId as string;
  madeOverHttp.push(clientId);
  return clientId;
}

const addDocument = (clientId: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/clients/${clientId}/documents`, cookies, headers, payload });

/* A row written the way an older desk wrote it: straight into the table,
   with any type at all. This is what "legacy" means below. */
async function plant(clientId: string, docType: string, docNumber: string, isPrimary: boolean, expiresOn = "2031-04-01") {
  await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, issuing_jurisdiction, expires_on, is_primary, created_by)
     SELECT $1, client_id, tenant_id, legal_entity_id, $2, $3, 'ON', $4, $5, 'test:legacy'
       FROM desk_clients WHERE client_id=$6`,
    [`doc_${randomUUID()}`, docType, docNumber, expiresOn, isPrimary, clientId],
  );
}

postgres("one ID-type catalogue, and no health numbers", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    records = new ClientRecordService(pool);
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [TENANT]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'ID Desk','CAD','pack-ca-v1',1) ON CONFLICT DO NOTHING`,
      [ENTITY, TENANT],
    );
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,$1) ON CONFLICT DO NOTHING",
      [BRANCH, TENANT, ENTITY],
    );
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [TILL.userId, TENANT, ENTITY, BRANCH, TILL.workspaceId, TILL.tillId, TILL.role, JSON.stringify([BRANCH])],
    );
    cookies = await signIn("a.singh");
  });

  afterAll(async () => {
    const ids = madeOverHttp;
    await pool.query("DELETE FROM ledger_customers WHERE client_id = ANY($1::text[]) OR tenant_id=$2", [ids, TENANT]);
    await pool.query("DELETE FROM desk_clients WHERE client_id = ANY($1::text[]) OR tenant_id=$2", [ids, TENANT]);
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  /* ------------------------------------------------------------------
     Writes
     ------------------------------------------------------------------ */

  it("refuses a type the catalogue does not list, with the accepted types named", async () => {
    const clientId = await openFile("Catalogue Unknown");
    const refused = await addDocument(clientId, { docType: "Library card", docNumber: "LIB-1" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: "ID_TYPE_NOT_IN_CATALOGUE",
      detail: SHOP_LIST,
      code: "ID_TYPE_NOT_IN_CATALOGUE",
      message: SHOP_LIST,
    });
    expect(refused.json().detail).toContain("Passport");
    expect(refused.json().detail).toContain("BC Services Card");
    const rows = await pool.query("SELECT 1 FROM desk_client_identity_documents WHERE client_id=$1", [clientId]);
    expect(rows.rowCount).toBe(0);
  });

  it("refuses a health card under any of its names, and stores nothing", async () => {
    const clientId = await openFile("Catalogue Health");
    for (const docType of ["Health Card", "OHIP", "Ontario Health Insurance Plan", "Carte d’assurance maladie", "MSP", "Care Card"]) {
      const refused = await addDocument(clientId, { docType, docNumber: "HN-NEW-PRIV", expiresOn: "2030-01-01" });
      expect(refused.statusCode, docType).toBe(422);
      expect(refused.json(), docType).toEqual({
        error: "HEALTH_CARD_NOT_ID",
        detail: HEALTH_SENTENCE,
        code: "HEALTH_CARD_NOT_ID",
        message: HEALTH_SENTENCE,
      });
    }
    const stored = await pool.query(
      "SELECT 1 FROM desk_client_identity_documents WHERE doc_number='HN-NEW-PRIV'",
    );
    expect(stored.rowCount).toBe(0);
  });

  it("accepts the BC Services Card as photo ID and stores an alias as the catalogue name", async () => {
    const clientId = await openFile("Catalogue BC");
    const bc = await addDocument(clientId, { docType: "BC Services Card", docNumber: "BCSC-7781", expiresOn: "2031-01-01" });
    expect(bc.statusCode, bc.body).toBe(201);
    expect(bc.json().verificationStatus).toBe("identified");
    expect(bc.json().documents[0]).toMatchObject({ docType: "BC Services Card", docNumber: "BCSC-7781" });

    const pr = await addDocument(clientId, { docType: "pr card", docNumber: "PR-4410", expiresOn: "2030-06-01", isPrimary: false });
    expect(pr.statusCode, pr.body).toBe(201);
    const stored = await pool.query(
      "SELECT doc_type FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY is_primary DESC",
      [clientId],
    );
    expect(stored.rows.map((r) => r.doc_type)).toEqual(["BC Services Card", "Permanent Resident Card"]);

    /* A change of type is checked the same way. */
    const passportId = (bc.json().documents as { documentId: string }[])[0]!.documentId;
    const toHealth = await app.inject({
      method: "PATCH", url: `/api/clients/${clientId}/documents/${passportId}`, cookies, headers,
      payload: { docType: "RAMQ" },
    });
    expect(toHealth.statusCode).toBe(422);
    expect(toHealth.json()).toMatchObject({ error: "HEALTH_CARD_NOT_ID", detail: HEALTH_SENTENCE });
    const toUnknown = await app.inject({
      method: "PATCH", url: `/api/clients/${clientId}/documents/${passportId}`, cookies, headers,
      payload: { docType: "Gym membership" },
    });
    expect(toUnknown.statusCode).toBe(422);
    expect(toUnknown.json()).toMatchObject({ error: "ID_TYPE_NOT_IN_CATALOGUE", detail: SHOP_LIST });
    const still = await pool.query("SELECT doc_type FROM desk_client_identity_documents WHERE document_id=$1", [passportId]);
    expect(still.rows[0]!.doc_type).toBe("BC Services Card");
  });

  it("accepts every business type, and the placeholder a new row starts with", async () => {
    const clientId = await openFile("Catalogue Holdings Inc.", "business");
    for (const docType of ["Business Number", "Incorporation Certificate", "Master Business Licence", "Articles of Incorporation", "Certificate of Incorporation"]) {
      const added = await addDocument(clientId, { docType, docNumber: `B-${docType.length}`, isPrimary: false });
      expect(added.statusCode, `${docType}: ${added.body}`).toBe(201);
    }
    /* "Add ID" on the desk opens a row before anybody has picked a type. */
    const placeholder = await addDocument(clientId, { docType: "Not stated", isPrimary: false });
    expect(placeholder.statusCode, placeholder.body).toBe(201);
    const row = (placeholder.json().documents as { docType: string; documentId: string }[])
      .find((d) => d.docType === "Not stated")!;
    const picked = await app.inject({
      method: "PATCH", url: `/api/clients/${clientId}/documents/${row.documentId}`, cookies, headers,
      payload: { docType: "Master Business License" },
    });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json().verificationStatus).toBe("identified");
    const types = await pool.query(
      "SELECT doc_type FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY doc_type",
      [clientId],
    );
    expect(types.rows.map((r) => r.doc_type)).toEqual([
      "Articles of Incorporation",
      "Business Number",
      "Incorporation Certificate",
      "Incorporation Certificate",
      "Master Business Licence",
      "Master Business Licence",
    ]);
  });

  /* ------------------------------------------------------------------
     Reads, over rows an older desk already wrote
     ------------------------------------------------------------------ */

  it("never returns or matches a stored health number, and still reads the row", async () => {
    const made = await records.create(TILL, { legalName: "Legacy Health Only" });
    const clientId = made.clientId as string;
    await plant(clientId, "OHIP", "HN-LEG-1-PRIV", true);
    await plant(clientId, "Health   Card", "HN-LEG-2-PRIV", false);
    /* Before this change a health number made the file identified. */
    await pool.query("UPDATE desk_clients SET verification_status='identified' WHERE client_id=$1", [clientId]);
    const secrets = ["HN-LEG-1-PRIV", "HN-LEG-2-PRIV"];

    const one = await records.get(TILL, clientId);
    const list = (await records.list(TILL)).clients.find((c) => c.clientId === clientId);
    const byName = (await records.lookupByName(TILL, "Legacy Health Only")).clients;
    for (const [where, body] of [["get", one], ["list", list], ["lookup", byName]] as const) {
      expect(healthLeaks(body, secrets), where).toEqual([]);
    }
    /* The rows are there, typed as they were stored, with no number key. */
    expect(one.documents).toHaveLength(2);
    for (const document of one.documents) {
      expect(Object.keys(document).filter((key) => NUMBER_KEYS.has(key))).toEqual([]);
    }
    expect(one.documents.map((d) => d.docType)).toEqual(["OHIP", "Health   Card"]);
    expect(one.documents[0]).toMatchObject({ expiresOn: "2031-04-01", issuingJurisdiction: "ON", isPrimary: true });
    /* A health card does not identify anybody. */
    expect(one.verificationStatus).toBe("unverified");

    /* Searching by the number finds nobody. */
    expect((await records.lookupByName(TILL, "HN-LEG-1-PRIV")).clients).toEqual([]);

    /* And the stored column is exactly as it was. */
    const stored = await pool.query(
      "SELECT doc_number FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY is_primary DESC",
      [clientId],
    );
    expect(stored.rows.map((r) => r.doc_number)).toEqual(secrets);
  });

  it("does not let a stored health card be edited, and lets a real ID be added beside it", async () => {
    const made = await records.create(TILL, { legalName: "Legacy Health Edit" });
    const clientId = made.clientId as string;
    await plant(clientId, "Carte d'assurance maladie", "HN-EDIT-PRIV", true);
    const health = (await records.get(TILL, clientId)).documents[0]!;

    for (const change of [{ docNumber: "HN-NEWER-PRIV" }, { expiresOn: "2035-01-01" }, { docType: "Passport" }]) {
      await expect(
        records.updateDocument(TILL, clientId, health.documentId as string, change),
      ).rejects.toMatchObject({ code: "HEALTH_CARD_NOT_ID", message: HEALTH_SENTENCE });
    }
    const unchanged = await pool.query(
      "SELECT doc_type, doc_number, expires_on::text FROM desk_client_identity_documents WHERE document_id=$1",
      [health.documentId],
    );
    expect(unchanged.rows[0]).toEqual({ doc_type: "Carte d'assurance maladie", doc_number: "HN-EDIT-PRIV", expires_on: "2031-04-01" });

    /* The till asks for this customer's counter record: no ID on file. */
    await records.counterRecord(TILL, clientId);
    const before = await pool.query("SELECT id_status FROM ledger_customers WHERE client_id=$1", [clientId]);
    expect(before.rows.map((r) => r.id_status)).toEqual(["missing"]);

    /* A passport becomes the primary. The health card stays, demoted,
       still without its number. */
    const withPassport = await records.addDocument(TILL, clientId, {
      docType: "Passport", docNumber: "PA-EDIT-1", expiresOn: "2032-01-01", isPrimary: true,
    });
    expect(withPassport.verificationStatus).toBe("identified");
    expect(withPassport.documents.find((d) => d.isPrimary)).toMatchObject({ docType: "Passport", docNumber: "PA-EDIT-1" });
    expect(healthLeaks(withPassport, ["HN-EDIT-PRIV"])).toEqual([]);
    const after = await pool.query("SELECT id_status FROM ledger_customers WHERE client_id=$1", [clientId]);
    expect(after.rows.map((r) => r.id_status)).toEqual(["verified"]);

    /* Removing the health card is allowed. */
    const removed = await records.removeDocument(TILL, clientId, health.documentId as string);
    expect(removed.documents.map((d) => d.docType)).toEqual(["Passport"]);
  });

  it("reads a legacy row of an unknown type as it was stored, number included", async () => {
    const made = await records.create(TILL, { legalName: "Legacy Unknown Type" });
    const clientId = made.clientId as string;
    await plant(clientId, "Birth certificate", "BIRTH-0042", true, "2099-01-01");
    const one = await records.get(TILL, clientId);
    expect(one.documents[0]).toMatchObject({ docType: "Birth certificate", docNumber: "BIRTH-0042" });
    const over = await app.inject({ method: "GET", url: "/api/clients", cookies, headers });
    expect(over.statusCode).toBe(200);
  });

  it("folds a type the same way in Postgres as in the catalogue", async () => {
    const names = [
      "Health Card", " health-card ", "Health   Card", "OHIP", "Carte d'assurance maladie",
      "Carte d’assurance maladie", "Régie de l'assurance maladie du Québec",
      "Driver's Licence", "BC Services Card", "Provincial/Territorial Photo ID", "mspaint",
    ];
    for (const name of names) {
      const folded = await pool.query(`SELECT ${typeKeySql("$1::text")} AS key`, [name]);
      expect(folded.rows[0]!.key, name).toBe(typeKey(name));
    }
  });

  /* ------------------------------------------------------------------
     The desk's saved document
     ------------------------------------------------------------------ */

  it("keeps a health number out of the saved desk: on save, on read, on a conflict, for a teller", async () => {
    const secret = "HN-STATE-PRIV";
    const prior = (await app.inject({ method: "GET", url: "/api/tenant/state", cookies })).json() as {
      state: Record<string, unknown> | null;
      version: number;
    };
    try {
      const clients = JSON.stringify({
        "Hana Health": { idType: "OHIP", idNum: secret, ids: [{ type: "MSP", num: secret }, { type: "Passport", num: "PA-STATE" }] },
      });
      const saved = await app.inject({
        method: "PUT", url: "/api/tenant/state", cookies,
        payload: { state: { ...(prior.state ?? {}), cdos_clients_v1: clients }, version: prior.version },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const row = await pool.query("SELECT state::text AS state FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
      expect(row.rows[0]!.state).not.toContain(secret);
      expect(row.rows[0]!.state).toContain("PA-STATE");

      /* A snapshot written before this change. */
      await pool.query(
        `UPDATE tenant_state SET state = jsonb_set(state, '{cdos_clients_v1}', to_jsonb($2::text)) WHERE tenant_id=$1`,
        [DEMO.tenantId, JSON.stringify({ Planted: { idType: "Health Card", idNum: secret } })],
      );
      const read = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
      expect(read.statusCode).toBe(200);
      expect(read.body).not.toContain(secret);
      const version = read.json().version as number;

      const conflict = await app.inject({
        method: "PUT", url: "/api/tenant/state", cookies,
        payload: { state: { cdos_clients_v1: "{}" }, version: version + 5 },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.body).not.toContain(secret);

      const teller = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: await signIn("m.costa") });
      expect(teller.statusCode).toBe(200);
      expect(teller.body).not.toContain(secret);
    } finally {
      /* Put the desk's document back as this test found it. */
      if (prior.state) {
        await pool.query("UPDATE tenant_state SET state=$2::jsonb WHERE tenant_id=$1", [
          DEMO.tenantId,
          JSON.stringify(prior.state),
        ]);
      } else {
        await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
      }
    }
  });

  it("does not file a birth certificate or a later citizenship certificate as ID", async () => {
    const clientId = await openFile("Catalogue Not Id");
    for (const docType of ["Birth certificate", "Citizenship certificate", "Citizenship certificate (2012 or later)"]) {
      const refused = await addDocument(clientId, { docType, docNumber: "NOT-ID-1", issuedOn: "2015-01-01" });
      expect(refused.statusCode, docType).toBe(422);
      expect(refused.json().code, docType).toBe("ID_TYPE_NOT_IN_CATALOGUE");
    }
    const paper = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/files`,
      cookies,
      headers,
      payload: {
        label: "Birth certificate",
        fileName: "birth.png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    });
    expect(paper.statusCode, paper.body).toBe(201);
    expect(paper.json().verificationStatus).toBe("unverified");
    expect(paper.json().documents).toEqual([]);
    expect(paper.json().files).toHaveLength(1);
    const idRows = await pool.query(
      "SELECT doc_type FROM desk_client_identity_documents WHERE client_id=$1",
      [clientId],
    );
    expect(idRows.rowCount).toBe(0);
  });

  it("requires the secure-card confirmation and an expiry on a status card", async () => {
    const clientId = await openFile("Catalogue Status");
    const laminated = await addDocument(clientId, {
      docType: "Secure Certificate of Indian Status",
      docNumber: "SC-1",
      expiresOn: "2032-01-01",
    });
    expect(laminated.statusCode).toBe(422);
    expect(laminated.json().code).toBe("LAMINATED_STATUS_CARD");
    const bare = await addDocument(clientId, {
      docType: "SCIS",
      docNumber: "SC-2",
      secureCard: true,
    });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().code).toBe("ID_EXPIRY_REQUIRED");
    const filed = await addDocument(clientId, {
      docType: "Secure Status Card",
      docNumber: "SC-3",
      expiresOn: "2032-01-01",
      secureCard: true,
    });
    expect(filed.statusCode, filed.body).toBe(201);
    expect(filed.json().verificationStatus).toBe("identified");
    expect(filed.json().documents[0]).toMatchObject({
      docType: "Secure Certificate of Indian Status",
      secureCard: true,
    });
    const none = await pool.query(
      "SELECT 1 FROM desk_client_identity_documents WHERE doc_number IN ('SC-1','SC-2')",
    );
    expect(none.rowCount).toBe(0);
  });

  it("files a pre-2012 citizenship card only in person, and only after the owner turns it on", async () => {
    const clientId = await openFile("Catalogue Citizen");
    const off = await addDocument(clientId, {
      docType: "Citizenship Card",
      docNumber: "CC-1",
      issuedOn: "2011-05-01",
      inPerson: true,
    });
    expect(off.statusCode).toBe(422);
    expect(off.json().code).toBe("ID_TYPE_NOT_ACCEPTED_HERE");
    const owner = await signIn("j.masri");
    const turned = await app.inject({
      method: "PUT",
      url: "/api/clients/accepted-id-types",
      cookies: owner,
      headers,
      payload: { accepted: [...idTypeRulesFor("CA").filter((rule) => rule.packDefault).map((rule) => rule.code), "citizenship_card"] },
    });
    expect(turned.statusCode, turned.body).toBe(200);
    try {
      const remote = await addDocument(clientId, {
        docType: "Citizenship Card",
        docNumber: "CC-REMOTE",
        issuedOn: "2011-05-01",
        inPerson: false,
      });
      expect(remote.statusCode).toBe(422);
      expect(remote.json().code).toBe("CITIZENSHIP_CARD_ISSUE_DATE");
      const late = await addDocument(clientId, {
        docType: "Citizenship Card",
        docNumber: "CC-LATE",
        issuedOn: "2012-02-01",
        inPerson: true,
      });
      expect(late.statusCode).toBe(422);
      expect(late.json().code).toBe("CITIZENSHIP_CARD_ISSUE_DATE");
      const filed = await addDocument(clientId, {
        docType: "Canadian Citizenship Card",
        docNumber: "CC-OK",
        issuedOn: "2011-05-01",
        inPerson: true,
      });
      expect(filed.statusCode, filed.body).toBe(201);
      expect(filed.json().verificationStatus).toBe("identified");
      expect(filed.json().documents[0]).toMatchObject({ docType: "Citizenship Card", inPerson: true });
      const stored = await pool.query(
        "SELECT doc_number FROM desk_client_identity_documents WHERE client_id=$1",
        [clientId],
      );
      expect(stored.rows.map((row) => row.doc_number)).toEqual(["CC-OK"]);
    } finally {
      await pool.query("UPDATE legal_entities SET accepted_id_types=NULL WHERE id=$1", [DEMO.legalEntityId]);
    }
  });

  it("refuses a passport with no expiry, and the client is not identified", async () => {
    const clientId = await openFile("Catalogue Passport Bare");
    for (const docType of ["Passport", "Driver's Licence", "Permanent Resident Card"]) {
      const refused = await addDocument(clientId, { docType, docNumber: "NO-EXP" });
      expect(refused.statusCode, docType).toBe(422);
      expect(refused.json().code, docType).toBe("ID_EXPIRY_REQUIRED");
    }
    const file = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies, headers });
    expect(file.json().verificationStatus).not.toBe("identified");
    const rows = await pool.query("SELECT 1 FROM desk_client_identity_documents WHERE client_id=$1", [clientId]);
    expect(rows.rowCount).toBe(0);
  });

  it("does not identify a pre-2012 citizenship card when inPerson is omitted", async () => {
    const clientId = await openFile("Catalogue Citizen Omitted");
    const owner = await signIn("j.masri");
    const turned = await app.inject({
      method: "PUT",
      url: "/api/clients/accepted-id-types",
      cookies: owner,
      headers,
      payload: { accepted: [...idTypeRulesFor("CA").filter((rule) => rule.packDefault).map((rule) => rule.code), "citizenship_card"] },
    });
    expect(turned.statusCode, turned.body).toBe(200);
    try {
      const omitted = await addDocument(clientId, {
        docType: "Citizenship Card",
        docNumber: "CC-OMIT",
        issuedOn: "2011-05-01",
      });
      expect(omitted.statusCode).toBe(422);
      expect(omitted.json().code).toBe("CITIZENSHIP_CARD_ISSUE_DATE");
      const file = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies, headers });
      expect(file.json().verificationStatus).not.toBe("identified");
      const rows = await pool.query("SELECT doc_number FROM desk_client_identity_documents WHERE client_id=$1", [clientId]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await pool.query("UPDATE legal_entities SET accepted_id_types=NULL WHERE id=$1", [DEMO.legalEntityId]);
    }
  });

  it("requires an expiry on a national or provincial photo ID, and never stores a BC health number", async () => {
    const clientId = await openFile("Catalogue Photo");
    const national = await addDocument(clientId, { docType: "National Identity Card", docNumber: "N-1" });
    expect(national.statusCode).toBe(422);
    expect(national.json().code).toBe("ID_EXPIRY_REQUIRED");
    const provincial = await addDocument(clientId, { docType: "Ontario Photo Card", docNumber: "ON-1" });
    expect(provincial.statusCode).toBe(422);
    expect(provincial.json().code).toBe("ID_EXPIRY_REQUIRED");
    const dated = await addDocument(clientId, {
      docType: "Provincial/Territorial Photo ID",
      docNumber: "ON-2",
      expiresOn: "2031-04-01",
    });
    expect(dated.statusCode, dated.body).toBe(201);
    const healthOnly = await addDocument(clientId, { docType: "BC Services Card health only", docNumber: "9123456789" });
    expect(healthOnly.statusCode).toBe(422);
    expect(healthOnly.json().code).toBe("HEALTH_CARD_NOT_ID");
    const phn = await addDocument(clientId, {
      docType: "BC Services Card",
      docNumber: "9123 456 789",
      expiresOn: "2031-04-01",
    });
    expect(phn.statusCode).toBe(422);
    expect(phn.json().code).toBe("HEALTH_NUMBER_NOT_STORED");
    const card = await addDocument(clientId, {
      docType: "BC Services Card with photo",
      docNumber: "BC-9912",
      expiresOn: "2031-04-01",
      isPrimary: false,
    });
    expect(card.statusCode, card.body).toBe(201);
    const leaked = await pool.query(
      "SELECT 1 FROM desk_client_identity_documents WHERE doc_number LIKE '%9123%' OR doc_number='9123456789'",
    );
    expect(leaked.rowCount).toBe(0);
  });
});
