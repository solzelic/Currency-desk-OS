/* ============================================================
   A customer is a person, not the spelling of their name.

   Every one of these tests fails against the code as it was, because as
   it was there was nothing on the server to ask. The customer file lived
   in one browser's `localStorage` under `cdos_clients_v1`, keyed BY THE
   CUSTOMER'S NAME, and the four defects that followed are the four
   things asserted here:

     • a rename moved the key, so a corrected spelling orphaned a
       person's history. Here identity survives a rename and the old name
       goes on resolving through an alias.
     • two people called David Chen were ONE file, silently. Here they
       are two records, and each is told about the other.
     • two counters were two shops. Here the same client is visible from
       a second till and a second BRANCH of the same legal entity — and
       is invisible to another tenant.
     • an identity document was a string inside a blob, so "who looked at
       this customer's passport" had no answer. Here documents are their
       own rows and looking at one writes an audit row in the same
       transaction that returns the bytes.

   The last test runs migration 019 over a desk's actual saved blob and
   asserts what arrived — including the alias that stops the migration
   orphaning anybody, and the flag on a file whose shape says it may be
   two people.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ClientRecordService } from "../src/clients/records.js";
import { CLASSIFICATION, IDENTIFYING_FIELDS, signalView } from "../src/clients/classification.js";
import type { LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let records: ClientRecordService;

/* One legal entity, two branches, three tills — because "one shop's
   customer is that shop's customer everywhere" is a claim that cannot be
   tested on a desk with one counter. */
const TENANT = "tnt-clients";
const ENTITY = "le-clients";
const BRANCH_MAIN = "br-clients-main";
const BRANCH_SECOND = "br-clients-second";
const WS_TILL_1 = "ws-clients-till-1";
const WS_TILL_2 = "ws-clients-till-2";
const WS_SECOND_BRANCH = "ws-clients-second-1";

/* And a second tenant, whose whole purpose is to see nothing. */
const OTHER_TENANT = "tnt-clients-other";
const OTHER_ENTITY = "le-clients-other";
const OTHER_BRANCH = "br-clients-other";
const OTHER_WS = "ws-clients-other-1";

const actorAt = (
  userId: string,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
  workspaceId: string,
  tillId: string,
  role = "supervisor",
): LedgerActor => ({
  userId,
  tenantId,
  legalEntityId,
  branchId,
  workspaceId,
  tillId,
  role,
  authorizedBranchIds: [branchId],
});

const TILL_1 = actorAt("u.one", TENANT, ENTITY, BRANCH_MAIN, WS_TILL_1, "till-1");
const TILL_2 = actorAt("u.two", TENANT, ENTITY, BRANCH_MAIN, WS_TILL_2, "till-2");
const OTHER_BRANCH_TILL = actorAt(
  "u.three", TENANT, ENTITY, BRANCH_SECOND, WS_SECOND_BRANCH, "till-1",
);
const STRANGER = actorAt(
  "u.stranger", OTHER_TENANT, OTHER_ENTITY, OTHER_BRANCH, OTHER_WS, "till-1",
);

/* A one-pixel PNG. Small on purpose — what is being proved is that the
   bytes leave the browser and that fetching them is recorded, not that
   Postgres can hold a photograph. */
const SCAN =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function principal(actor: LedgerActor) {
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id)
     DO UPDATE SET role=EXCLUDED.role, authorized_branch_ids=EXCLUDED.authorized_branch_ids`,
    [
      actor.userId,
      actor.tenantId,
      actor.legalEntityId,
      actor.branchId,
      actor.workspaceId,
      actor.tillId,
      actor.role,
      JSON.stringify(actor.authorizedBranchIds),
    ],
  );
}

async function topology() {
  for (const [tenantId, entityId] of [
    [TENANT, ENTITY],
    [OTHER_TENANT, OTHER_ENTITY],
  ]) {
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [tenantId]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'Client Desk','CAD','pack-ca-v1',1) ON CONFLICT DO NOTHING`,
      [entityId, tenantId],
    );
  }
  for (const [branchId, tenantId, entityId] of [
    [BRANCH_MAIN, TENANT, ENTITY],
    [BRANCH_SECOND, TENANT, ENTITY],
    [OTHER_BRANCH, OTHER_TENANT, OTHER_ENTITY],
  ]) {
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,$1) ON CONFLICT DO NOTHING",
      [branchId, tenantId, entityId],
    );
  }
  for (const actor of [TILL_1, TILL_2, OTHER_BRANCH_TILL, STRANGER]) await principal(actor);
}

async function wipe() {
  await pool.query(
    "DELETE FROM ledger_customers WHERE tenant_id = ANY($1::text[])",
    [[TENANT, OTHER_TENANT]],
  );
  await pool.query("DELETE FROM desk_clients WHERE tenant_id = ANY($1::text[])", [
    [TENANT, OTHER_TENANT],
  ]);
  /* TRUNCATE rather than DELETE, and the difference is the point: the
     audit table carries an append-only trigger that refuses a DELETE
     outright. A test that could quietly remove audit rows would be a
     test running against a weaker table than production has. */
  await pool.query("TRUNCATE ledger_audit_events");
}

const auditRows = (action: string) =>
  pool
    .query(
      "SELECT * FROM ledger_audit_events WHERE tenant_id=$1 AND action=$2 ORDER BY created_at",
      [TENANT, action],
    )
    .then((r) => r.rows);

postgres("the desk's customer file, on the server", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    records = new ClientRecordService(pool);
    await topology();
  });

  afterAll(async () => {
    await wipe();
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(wipe);

  /* ------------------------------------------------------------------
     Identity
     ------------------------------------------------------------------ */

  it("keeps one identity across a rename, and the old name still resolves", async () => {
    const created = await records.create(TILL_1, {
      legalName: "Jonh Smith",
      dateOfBirth: "1979-03-04",
      phone: "(416) 555-0100",
    });
    expect(created.clientId).toMatch(/^cli_/);
    /* The id is not the name, and nothing about it is derived from the
       name. If it were, everything below would be theatre. */
    expect(created.clientId).not.toContain("smith");

    const renamed = await records.update(TILL_1, created.clientId as string, {
      legalName: "John Smith",
    });
    expect(renamed.clientId).toBe(created.clientId);
    expect(renamed.legalName).toBe("John Smith");
    /* Everything filed under the misspelling — a transaction, a report,
       a regulator's letter — goes on resolving to this person. That is
       the whole reason a rename is now safe. */
    expect(renamed.aliases.map((a) => a.alias)).toContain("Jonh Smith");

    const byOldName = await records.lookupByName(TILL_1, "jonh  smith");
    expect(byOldName.clients.map((c) => c.clientId)).toEqual([created.clientId]);
    const byNewName = await records.lookupByName(TILL_1, "John Smith");
    expect(byNewName.clients.map((c) => c.clientId)).toEqual([created.clientId]);

    /* The ledger's counter row followed the rename rather than being
       left behind under the old spelling — the two are views of one
       person, joined by id. */
    const counter = await pool.query(
      "SELECT name, client_id FROM ledger_customers WHERE client_id=$1",
      [created.clientId],
    );
    expect(counter.rows.map((r) => r.name)).toEqual(["John Smith"]);

    const renames = await auditRows("client.rename");
    expect(renames).toHaveLength(1);
    expect(renames[0].reason).toContain("Jonh Smith → John Smith");
  });

  it("two customers with the same name are two records, and each is told about the other", async () => {
    const first = await records.create(TILL_1, {
      legalName: "David Chen",
      dateOfBirth: "1968-11-02",
    });
    const second = await records.create(TILL_1, {
      legalName: "David  Chen",
      dateOfBirth: "1994-06-21",
    });
    expect(second.clientId).not.toBe(first.clientId);

    /* Creating the second one is ALLOWED. A product that refuses is the
       same defect as one that merges, wearing a warning label. */
    const reread = await records.get(TILL_1, first.clientId as string);
    expect(reread.sameNameClientIds).toEqual([second.clientId]);
    expect(reread.dateOfBirth).toBe("1968-11-02");

    const all = await records.list(TILL_1);
    expect(all.clients).toHaveLength(2);
    for (const client of all.clients) expect(client.sameNameClientIds).toHaveLength(1);

    /* And each has their own counter record, so a deal posted for one is
       never posted against the other's history. */
    const counters = await pool.query(
      "SELECT client_id FROM ledger_customers WHERE tenant_id=$1 ORDER BY client_id",
      [TENANT],
    );
    expect(new Set(counters.rows.map((r) => r.client_id)).size).toBe(2);
  });

  /* ------------------------------------------------------------------
     Scope — the whole shop, and only the shop
     ------------------------------------------------------------------ */

  it("is one shop's customer at every till and every branch, and nobody else's", async () => {
    const made = await records.create(TILL_1, { legalName: "Amara Okafor", city: "Toronto" });

    const fromSecondTill = await records.list(TILL_2);
    expect(fromSecondTill.clients.map((c) => c.clientId)).toContain(made.clientId);

    /* The one that decides whether multi-branch costs an afternoon or a
       rewrite. `desk_clients` is keyed on the LEGAL ENTITY, so a second
       location opened next year sees the customers the first one
       collected without anything being migrated. */
    const fromSecondBranch = await records.list(OTHER_BRANCH_TILL);
    expect(fromSecondBranch.clients.map((c) => c.clientId)).toContain(made.clientId);
    const readThere = await records.get(OTHER_BRANCH_TILL, made.clientId as string);
    expect(readThere.legalName).toBe("Amara Okafor");

    /* And a different registered business sees nothing at all. */
    const stranger = await records.list(STRANGER);
    expect(stranger.clients).toEqual([]);
    await expect(records.get(STRANGER, made.clientId as string)).rejects.toMatchObject({
      code: "CLIENT_NOT_FOUND",
    });
  });

  it("gives each till its own counter record for the same person", async () => {
    const made = await records.create(TILL_1, { legalName: "Priya Raman" });
    const atTwo = await records.counterRecord(TILL_2, made.clientId as string);
    const rows = await pool.query(
      "SELECT workspace_id, customer_id FROM ledger_customers WHERE client_id=$1 ORDER BY workspace_id",
      [made.clientId],
    );
    /* Two rows, two tills, ONE person. The posting path keeps its
       workspace-scoped row and stops being a second customer concept. */
    expect(rows.rows.map((r) => r.workspace_id)).toEqual([WS_TILL_1, WS_TILL_2]);
    expect(rows.rows.map((r) => r.customer_id)).toContain(atTwo.customerId);
  });

  /* ------------------------------------------------------------------
     Documents
     ------------------------------------------------------------------ */

  it("keeps identity documents as their own rows, several per person", async () => {
    const made = await records.create(TILL_1, { legalName: "Lucia Ferreira" });
    const clientId = made.clientId as string;
    await records.addDocument(TILL_1, clientId, {
      docType: "Passport",
      docNumber: "PA-4471902",
      issuingJurisdiction: "Portugal",
      expiresOn: "2031-08-14",
      scanDataUrl: SCAN,
    });
    const withBoth = await records.addDocument(TILL_1, clientId, {
      docType: "PR Card",
      docNumber: "PR-88120",
      expiresOn: "2029-01-31",
    });

    expect(withBoth.documents).toHaveLength(2);
    /* Rows in their own table, not fields on the customer — which is
       what makes "the signal side of this person joins nothing that
       identifies them" a table boundary rather than a promise. */
    const stored = await pool.query(
      "SELECT doc_type, is_primary FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY is_primary DESC",
      [clientId],
    );
    expect(stored.rows.map((r) => r.doc_type)).toEqual(["Passport", "PR Card"]);
    /* Exactly one drives the desk's KYC standing. The old shape let a
       top-level ID and an array entry both claim to be it. */
    expect(stored.rows.filter((r) => r.is_primary)).toHaveLength(1);

    /* Metadata says a scan exists. The bytes are not in the answer —
       forty customers on a list screen must not be forty passports on
       the wire. */
    const passport = withBoth.documents.find((d) => d.docType === "Passport")!;
    expect(passport.hasScan).toBe(true);
    expect(JSON.stringify(withBoth)).not.toContain("iVBORw0KGgo");
  });

  it("records who looked at an identity document, in the same transaction that hands it over", async () => {
    const made = await records.create(TILL_1, { legalName: "Tomas Novak" });
    const clientId = made.clientId as string;
    const withDoc = await records.addDocument(TILL_1, clientId, {
      docType: "Passport",
      docNumber: "CZ-9910",
      scanDataUrl: SCAN,
    });
    const documentId = withDoc.documents[0]!.documentId as string;

    expect(await auditRows("client.document.view")).toHaveLength(0);

    const revealed = await records.revealDocumentScan(
      TILL_2,
      clientId,
      documentId,
      "counter check",
    );
    expect(revealed.dataUrl).toBe(SCAN);

    const viewed = await auditRows("client.document.view");
    expect(viewed).toHaveLength(1);
    expect(viewed[0].actor_id).toBe(TILL_2.userId);
    expect(viewed[0].target_id).toBe(documentId);
    expect(viewed[0].reason).toContain("Tomas Novak");
    expect(viewed[0].reason).toContain("Passport");
    expect(viewed[0].reason).toContain("counter check");
    /* The trail says who looked, never what they saw. An audit log that
       quotes passport numbers is a second copy of the thing being
       protected, in a table designed to be read widely and kept for
       years. */
    expect(viewed[0].reason).not.toContain("CZ-9910");

    /* A second look is a second row. "Somebody opened it once, months
       ago" and "three people opened it this morning" are different
       facts. */
    await records.revealDocumentScan(TILL_1, clientId, documentId);
    expect(await auditRows("client.document.view")).toHaveLength(2);

    const disclosures = await records.disclosures(TILL_1, clientId, 50);
    expect(
      disclosures.events.filter((e) => e.action === "client.document.view"),
    ).toHaveLength(2);
  });

  it("has no unaudited way to the bytes", async () => {
    const made = await records.create(TILL_1, { legalName: "Grace Adeyemi" });
    const clientId = made.clientId as string;
    const withDoc = await records.addDocument(TILL_1, clientId, {
      docType: "Driver's Licence",
      docNumber: "D-5512",
      scanDataUrl: SCAN,
    });

    /* Neither the list nor the record carries a scan. If either did, the
       audit row would be a courtesy rather than a control. */
    const list = await records.list(TILL_1);
    const one = await records.get(TILL_1, clientId);
    expect(JSON.stringify(list)).not.toContain("iVBORw0KGgo");
    expect(JSON.stringify(one)).not.toContain("iVBORw0KGgo");
    expect(await auditRows("client.document.view")).toHaveLength(0);

    /* A document with no scan says so rather than returning nothing that
       looks like an empty picture. */
    const typedOnly = await records.addDocument(TILL_1, clientId, {
      docType: "Health Card",
      docNumber: "H-1",
    });
    const bare = typedOnly.documents.find((d) => d.docType === "Health Card")!;
    await expect(
      records.revealDocumentScan(TILL_1, clientId, bare.documentId as string),
    ).rejects.toMatchObject({ code: "SCAN_NOT_ON_FILE" });

    /* And another tenant cannot reveal it at all, even holding the ids. */
    await expect(
      records.revealDocumentScan(
        STRANGER,
        clientId,
        withDoc.documents[0]!.documentId as string,
      ),
    ).rejects.toMatchObject({ code: "CLIENT_DOCUMENT_NOT_FOUND" });
  });

  it("holds a client photograph as its own thing, not as another ID", async () => {
    const made = await records.create(TILL_1, { legalName: "Sofia Marchetti" });
    const clientId = made.clientId as string;
    await records.setPhotograph(TILL_1, clientId, SCAN);
    await records.addDocument(TILL_1, clientId, { docType: "Passport", scanDataUrl: SCAN });

    const record = await records.get(TILL_1, clientId);
    /* One photograph, one document, and the photograph is NOT in the
       document list — different purpose, different sensitivity,
       different retention answer. */
    expect(record.photograph).not.toBeNull();
    expect(record.documents).toHaveLength(1);
    expect(record.documents[0]!.docType).toBe("Passport");

    const held = await pool.query(
      "SELECT purpose, document_id FROM desk_client_images WHERE client_id=$1 ORDER BY purpose",
      [clientId],
    );
    expect(held.rows.map((r) => r.purpose)).toEqual(["client_photograph", "identity_document"]);
    expect(held.rows[0]!.document_id).toBeNull();
  });

  /* ------------------------------------------------------------------
     The line between identifying and signal
     ------------------------------------------------------------------ */

  it("cannot leak an identifying field through the signal projection", async () => {
    const made = await records.create(TILL_1, {
      legalName: "Hannah Weiss",
      dateOfBirth: "1990-02-02",
      addressLine: "14 Elm Street",
      city: "Toronto",
      region: "ON",
      country: "Canada",
      postalCode: "M5V 2T6",
      email: "hannah@example.com",
      phone: "(416) 555-0199",
      notes: "sister of the woman at number 12",
      riskRating: "medium",
      occupation: "Nurse",
    });
    const view = signalView(made as unknown as Record<string, unknown>);

    for (const field of IDENTIFYING_FIELDS) expect(view).not.toHaveProperty(field);
    /* Specifically, and by name, because these are the ones somebody
       would reach for. */
    expect(JSON.stringify(view)).not.toContain("14 Elm Street");
    expect(JSON.stringify(view)).not.toContain("Hannah Weiss");
    expect(JSON.stringify(view)).not.toContain("1990-02-02");
    expect(JSON.stringify(view)).not.toContain("hannah@example.com");
    expect(JSON.stringify(view)).not.toContain("sister of the woman");

    /* And it still says something worth saying — a projection that
       leaked nothing because it contained nothing would pass the test
       above and be useless. */
    expect(view.riskRating).toBe("medium");
    expect(view.region).toBe("ON");
    expect(view.country).toBe("Canada");
    expect(view.verificationStatus).toBe("unverified");

    /* An allow-list, not a deny-list: a field nobody has classified is a
       field nobody may share, including one invented after this test was
       written. */
    const withNewColumn = signalView({ ...(made as object), someFutureColumn: "secret" });
    expect(withNewColumn).not.toHaveProperty("someFutureColumn");
    expect(CLASSIFICATION).not.toHaveProperty("someFutureColumn");
  });

  it("reserves the cross-desk match column and writes nothing to it", async () => {
    const made = await records.create(TILL_1, { legalName: "Nobody Yet", dateOfBirth: "1980-01-01" });
    const row = await pool.query(
      "SELECT network_match_hash, network_match_hash_version FROM desk_clients WHERE client_id=$1",
      [made.clientId],
    );
    /* The column exists so the decision stays possible; nothing fills it
       because filling it is a decision with a legal basis this change
       deliberately does not assume. If this ever starts failing,
       somebody has begun building cross-desk matching and should have
       had that conversation first. */
    expect(row.rows[0]!.network_match_hash).toBeNull();
    expect(row.rows[0]!.network_match_hash_version).toBeNull();
  });

  /* ------------------------------------------------------------------
     Over HTTP, with a real session
     ------------------------------------------------------------------ */

  it("answers the desk over HTTP and refuses a stranger", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "a.singh", password: DEMO.password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = {
      cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
    };
    /* Which till this request is FOR, stated — exactly as the browser's
       Backend client states it on every call.

       Without it, `resolveActor` falls back to "the only workspace at
       this branch", which is not a thing on a desk with two tills. This
       test passed for as long as it happened to run before the suite
       that adds till-11 to the demo branch and leaves it there, and
       returned SCOPE_DENIED the moment file ordering changed. A test
       that silently depends on a single-till desk is testing an
       accident. */
    const headers = { "x-workspace-id": DEMO.workspaceId };

    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      headers,
      payload: { legalName: "Wei Zhang", kind: "individual", riskRating: "normal" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const clientId = created.json().clientId as string;

    const listed = await app.inject({ method: "GET", url: "/api/clients", cookies, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().clients.map((c: { clientId: string }) => c.clientId)).toContain(clientId);

    /* Assert on the response, not merely that a request was fired. A
       fixture that ignored what came back is how a 500 hid here for
       months. */
    const unauthenticated = await app.inject({ method: "GET", url: "/api/clients" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().code).toBe("AUTHENTICATION_REQUIRED");

    const nonsense = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      headers,
      payload: { legalName: "", dateOfBirth: "1985-13-45" },
    });
    expect(nonsense.statusCode).toBe(422);
    expect(nonsense.json().message).toMatch(/legalName|dateOfBirth/);

    await pool.query("DELETE FROM ledger_customers WHERE client_id=$1", [clientId]);
    await pool.query("DELETE FROM desk_clients WHERE client_id=$1", [clientId]);
  });
});

/* ============================================================
   The desk that is already trading.

   Migration 019 is re-run here over a blob shaped exactly like the one a
   working desk has been saving: clients keyed by name, a primary ID as
   loose fields, extra IDs in an array, and one file that is obviously
   two people. What must arrive is one client per key, the old key kept
   as an alias, documents as rows — and a FLAG, not a split, on the file
   that looks like two.
   ============================================================ */
postgres("migration 019, over a desk's existing blob", () => {
  const BLOB_TENANT = "tnt-blob-desk";
  const BLOB_ENTITY = "le-blob-desk";

  const blob = {
    "Jonh Smith": {
      kind: "individual",
      dob: "1979-03-04",
      email: "jonh@example.com",
      phone: "(416) 555-0100",
      address: "14 Elm Street",
      city: "Toronto",
      province: "ON",
      postal: "M5V 2T6",
      country: "Canada",
      occupation: "Nurse",
      risk: "Medium",
      notes: "regular, Tuesdays",
      idType: "Passport",
      idNum: "PA-11223",
      idIssued: "2019-05-01",
      idExpiry: "2029-05-01",
      photo: SCAN,
      avatar: "data:image/png;base64,AAAA",
      ids: [{ type: "PR Card", num: "PR-9001", expiry: "2030-01-01", photo: SCAN }],
    },
    /* The file that is two people: two passports, two numbers. Nothing
       is split — a flag and a sentence, so somebody who knows the
       customers can look. */
    "David Chen": {
      kind: "individual",
      idType: "Passport",
      idNum: "PP-100",
      ids: [
        { type: "Passport", num: "PP-999", expiry: "2028-04-04" },
      ],
    },
    "Acme Imports Ltd.": {
      kind: "corporate",
      incorpDate: "2011-09-15",
      jurisdiction: "Ontario, Canada",
      business: "Import / export of goods",
      contactName: "Rita Alvarez",
      contactTitle: "Director",
      risk: "high",
    },
    /* An expired ID. It arrives as 'expired', not as 'verified' — the
       migration may not upgrade somebody's KYC standing on the way
       past. */
    "Marta Kovac": { kind: "individual", idType: "Passport", idNum: "MK-1", idExpiry: "2001-01-01" },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);

    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [BLOB_TENANT]);
    await pool.query(
      "INSERT INTO legal_entities (id,tenant_id,name) VALUES ($1,$2,'Blob Desk') ON CONFLICT DO NOTHING",
      [BLOB_ENTITY, BLOB_TENANT],
    );
    await pool.query(
      `INSERT INTO tenant_state (tenant_id,state) VALUES ($1,$2::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET state=EXCLUDED.state`,
      [BLOB_TENANT, JSON.stringify({ cdos_clients_v1: JSON.stringify(blob), cdos_theme: "dark" })],
    );
    /* A customer the ledger knows and the blob does not — created
       straight at the till, which the ledger has always allowed. It has
       to arrive too, and it has to be JOINED rather than duplicated. */
    await pool.query(
      `INSERT INTO ledger_customers
        (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,external_ref,name,risk,id_status,created_at,updated_at)
       VALUES ('cust-blob-till','${BLOB_TENANT}','${BLOB_ENTITY}','br-x','ws-x','os:till-only','Till Only','normal','verified',now(),now()),
              ('cust-blob-jonh','${BLOB_TENANT}','${BLOB_ENTITY}','br-x','ws-x','os:jonh-smith','Jonh Smith','normal','verified',now(),now())
       ON CONFLICT DO NOTHING`,
    );

    /* Re-run the data migration over what was just planted. Every
       statement in 019 is IF NOT EXISTS / WHERE NOT EXISTS, so this is
       the same work a fresh database does — it is just being given
       something to do. */
    await pool.query("DELETE FROM schema_migrations WHERE migration_id='019_client_records'");
    await runMigrations(pool, [
      ["019_client_records", "src/db/migrations/019_client_records.sql"],
    ]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM ledger_customers WHERE tenant_id=$1", [BLOB_TENANT]);
    await pool.query("DELETE FROM desk_clients WHERE tenant_id=$1", [BLOB_TENANT]);
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [BLOB_TENANT]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  const clientNamed = (name: string) =>
    pool
      .query("SELECT * FROM desk_clients WHERE tenant_id=$1 AND display_name=$2", [BLOB_TENANT, name])
      .then((r) => r.rows[0]);

  it("brings every name-key across as one client, with the old key kept as an alias", async () => {
    const all = await pool.query(
      "SELECT display_name FROM desk_clients WHERE tenant_id=$1 ORDER BY display_name",
      [BLOB_TENANT],
    );
    expect(all.rows.map((r) => r.display_name)).toEqual([
      "Acme Imports Ltd.",
      "David Chen",
      "Jonh Smith",
      "Marta Kovac",
      "Till Only",
    ]);

    /* The alias is what stops this migration orphaning anybody: every
       transaction, filing and report already written under the old key
       still resolves. */
    const jonh = await clientNamed("Jonh Smith");
    const aliases = await pool.query(
      "SELECT alias, alias_kind FROM desk_client_aliases WHERE client_id=$1",
      [jonh.client_id],
    );
    expect(aliases.rows).toEqual([{ alias: "Jonh Smith", alias_kind: "legacy_name_key" }]);
  });

  it("carries the fields the browser held, on the right side of the line", async () => {
    const jonh = await clientNamed("Jonh Smith");
    expect(jonh.date_of_birth.toISOString().slice(0, 10)).toBe("1979-03-04");
    expect(jonh.address_line).toBe("14 Elm Street");
    expect(jonh.city).toBe("Toronto");
    expect(jonh.region).toBe("ON");
    expect(jonh.country).toBe("Canada");
    expect(jonh.occupation).toBe("Nurse");
    /* Four spellings of the same tier in the blob, one vocabulary
       here. Anything unrecognised becomes 'normal' rather than being
       guessed upward. */
    expect(jonh.risk_rating).toBe("medium");
    /* Papers on file is 'identified', never 'verified'. The migration
       does not get to assert a KYC outcome nobody paid a provider
       for. */
    expect(jonh.verification_status).toBe("identified");

    const acme = await clientNamed("Acme Imports Ltd.");
    expect(acme.kind).toBe("business");
    expect(acme.incorporation_date.toISOString().slice(0, 10)).toBe("2011-09-15");
    expect(acme.nature_of_business).toBe("Import / export of goods");
    expect(acme.contact_name).toBe("Rita Alvarez");
    expect(acme.risk_rating).toBe("high");

    const marta = await clientNamed("Marta Kovac");
    expect(marta.verification_status).toBe("expired");
  });

  it("turns the primary ID and the ids[] array into equal rows", async () => {
    const jonh = await clientNamed("Jonh Smith");
    const documents = await pool.query(
      "SELECT doc_type,doc_number,is_primary FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY is_primary DESC",
      [jonh.client_id],
    );
    expect(documents.rows).toEqual([
      { doc_type: "Passport", doc_number: "PA-11223", is_primary: true },
      { doc_type: "PR Card", doc_number: "PR-9001", is_primary: false },
    ]);
  });

  it("flags the file that looks like two people, and splits nothing", async () => {
    const david = await clientNamed("David Chen");
    expect(david.possible_duplicate).toBe(true);
    expect(david.duplicate_reason).toMatch(/more than one document of the same type/i);
    /* Both documents are still on the one file. Splitting on a guess
       would invent a customer who never existed and hand half a
       transaction history to each. */
    const documents = await pool.query(
      "SELECT doc_number FROM desk_client_identity_documents WHERE client_id=$1 ORDER BY doc_number",
      [david.client_id],
    );
    expect(documents.rows.map((r) => r.doc_number)).toEqual(["PP-100", "PP-999"]);

    const jonh = await clientNamed("Jonh Smith");
    expect(jonh.possible_duplicate).toBe(false);
  });

  it("takes the scans out of the browser's saving limit and puts them behind the audit", async () => {
    const jonh = await clientNamed("Jonh Smith");
    const images = await pool.query(
      `SELECT i.purpose, i.content_type, i.byte_size, d.doc_type
         FROM desk_client_images i
         LEFT JOIN desk_client_identity_documents d ON d.document_id = i.document_id
        WHERE i.client_id=$1 ORDER BY i.purpose, d.doc_type`,
      [jonh.client_id],
    );
    /* Both ID scans and the contact photograph came out of the blob —
       which is the four-megabyte ceiling this desk was heading for — and
       the photograph is kept as its own purpose rather than being
       filed as a third identity document. */
    expect(images.rows.map((r) => [r.purpose, r.doc_type])).toEqual([
      ["client_photograph", null],
      ["identity_document", "PR Card"],
      ["identity_document", "Passport"],
    ]);
    for (const row of images.rows) expect(row.byte_size).toBeGreaterThan(0);
    expect(images.rows[1]!.content_type).toBe("image/png");

    /* A scan the desk never had does not become an empty one. */
    const marta = await clientNamed("Marta Kovac");
    const none = await pool.query("SELECT count(*)::int AS n FROM desk_client_images WHERE client_id=$1", [
      marta.client_id,
    ]);
    expect(none.rows[0]!.n).toBe(0);
  });

  it("joins the ledger's own rows to the person rather than making a third concept", async () => {
    const rows = await pool.query(
      `SELECT lc.name, lc.client_id, c.display_name
         FROM ledger_customers lc
         LEFT JOIN desk_clients c ON c.client_id = lc.client_id
        WHERE lc.tenant_id=$1 ORDER BY lc.name`,
      [BLOB_TENANT],
    );
    /* Every ledger row points at a client. The row the blob already
       described attaches to that client; the one only the ledger knew
       about mints its own. */
    expect(rows.rows.every((r) => r.client_id)).toBe(true);
    expect(rows.rows.map((r) => r.display_name)).toEqual(["Jonh Smith", "Till Only"]);
  });

  it("survives a desk whose saved document is not valid JSON", async () => {
    /* One desk's truncated blob must not block every other desk's
       migration. Asserted rather than assumed, because the only way to
       find out otherwise is a failed production deploy. */
    await pool.query("INSERT INTO tenants (id,name) VALUES ('tnt-broken','tnt-broken') ON CONFLICT DO NOTHING");
    await pool.query(
      "INSERT INTO legal_entities (id,tenant_id,name) VALUES ('le-broken','tnt-broken','Broken') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO tenant_state (tenant_id,state) VALUES ('tnt-broken', $1::jsonb)
       ON CONFLICT (tenant_id) DO UPDATE SET state=EXCLUDED.state`,
      [JSON.stringify({ cdos_clients_v1: "{ not even json" })],
    );
    await pool.query("DELETE FROM schema_migrations WHERE migration_id='019_client_records'");
    await expect(
      runMigrations(pool, [["019_client_records", "src/db/migrations/019_client_records.sql"]]),
    ).resolves.toBeUndefined();
    const broken = await pool.query("SELECT count(*)::int AS n FROM desk_clients WHERE tenant_id='tnt-broken'");
    expect(broken.rows[0]!.n).toBe(0);
    await pool.query("DELETE FROM tenant_state WHERE tenant_id='tnt-broken'");
    await pool.query("DELETE FROM legal_entities WHERE id='le-broken'");
    await pool.query("DELETE FROM tenants WHERE id='tnt-broken'");
  });
});
