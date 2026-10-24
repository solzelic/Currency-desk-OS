/* ============================================================
   Settings → Accepted IDs, against Postgres.

   The route (`/api/clients/accepted-id-types`) on the York demo desk:
   every role reads the list; only the owner changes it; a change is an
   audit row naming what went on and off and never a document number;
   a locked type and a list with no photo ID are refused with nothing
   written. Then the customer file: a switched-off type is refused on
   add and on update, a document already on file of that type still
   reads with its verification status and a quiet notice, and NULL
   follows the pack.

   The demo desk is shared with every other suite, so its list goes
   back to NULL when this file is done.
   ============================================================ */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { resolveAcceptedIdTypes } from "../src/clients/accepted-id-types.js";
import { CANADA_HEALTH_CARD_NOTE, NEVER_ID_NOTE, idTypeRulesFor } from "../src/ledger/id-type-rules.js";
import { ID_DOCUMENT_TYPES, notInCatalogueSentence } from "../src/clients/id-document-types.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const ROUTE = "/api/clients/accepted-id-types";
const headers = { "x-workspace-id": DEMO.workspaceId };
const PACK_DEFAULTS = idTypeRulesFor("CA").filter((rule) => rule.packDefault);
const ALL = PACK_DEFAULTS.map((rule) => rule.code);
const PACK_LIST = notInCatalogueSentence(PACK_DEFAULTS.map((rule) => rule.label));
const WITHOUT_NATIONAL_ID = ALL.filter((code) => code !== "national_id_card");
const NOT_HERE = "This shop doesn't accept National Identity Card. The owner can change this in Settings → Accepted IDs.";
const NO_LONGER = "This shop no longer accepts National Identity Card. Record another ID at the next visit.";
const OWNER_ONLY = "Only the owner can change which IDs this shop accepts.";

/* A fixture desk on the current United Kingdom pack, for the pack
   that is not Canada's. Read through the resolver; nobody signs in. */
const GB_TENANT = "tnt-accepted-gb";
const GB_ENTITY = "le-accepted-gb";

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
const sessions: Record<string, Record<string, string>> = {};
const madeOverHttp: string[] = [];

async function signIn(staffId: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((c) => c.name === "cdos_session")!.value };
}

const read = (who: string) =>
  app.inject({ method: "GET", url: ROUTE, cookies: sessions[who], headers });

const write = (who: string, accepted: unknown) =>
  app.inject({ method: "PUT", url: ROUTE, cookies: sessions[who], headers, payload: { accepted } });

const stored = async () =>
  (await pool.query("SELECT accepted_id_types FROM legal_entities WHERE id=$1", [DEMO.legalEntityId]))
    .rows[0]!.accepted_id_types as string[] | null;

const auditRows = async () =>
  (await pool.query(
    `SELECT actor_id, reason FROM ledger_audit_events
      WHERE legal_entity_id=$1 AND action='desk.id_types.change'
      ORDER BY created_at, event_id`,
    [DEMO.legalEntityId],
  )).rows as { actor_id: string; reason: string }[];

async function openFile(legalName: string) {
  const res = await app.inject({
    method: "POST", url: "/api/clients", cookies: sessions["a.singh"], headers,
    payload: { legalName, kind: "individual" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const clientId = res.json().clientId as string;
  madeOverHttp.push(clientId);
  return clientId;
}

const addDocument = (clientId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "POST", url: `/api/clients/${clientId}/documents`,
    cookies: sessions["a.singh"], headers, payload,
  });

const patchDocument = (clientId: string, documentId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: "PATCH", url: `/api/clients/${clientId}/documents/${documentId}`,
    cookies: sessions["a.singh"], headers, payload,
  });

const backToThePack = () =>
  pool.query("UPDATE legal_entities SET accepted_id_types=NULL WHERE id=$1", [DEMO.legalEntityId]);

postgres("Settings → Accepted IDs", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    await backToThePack();
    for (const staffId of ["j.masri", "r.haddad", "a.singh", "m.costa"]) sessions[staffId] = await signIn(staffId);
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING", [GB_TENANT]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'GB Desk','GBP','pack-gb-v2',2) ON CONFLICT DO NOTHING`,
      [GB_ENTITY, GB_TENANT],
    );
  });

  beforeEach(backToThePack);

  afterAll(async () => {
    if (pool) {
      await backToThePack();
      await pool.query("DELETE FROM ledger_customers WHERE client_id = ANY($1::text[])", [madeOverHttp]);
      await pool.query("DELETE FROM desk_clients WHERE client_id = ANY($1::text[])", [madeOverHttp]);
      await pool.query("DELETE FROM legal_entities WHERE id=$1", [GB_ENTITY]);
      await pool.query("DELETE FROM tenants WHERE id=$1", [GB_TENANT]);
      await pool.end();
    }
    if (app) await app.close();
    if (handle) await handle.close();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  /* ------------------------------------------------------------------
     The route
     ------------------------------------------------------------------ */

  it("lets every role read the list, and says only the owner may change it", async () => {
    for (const staffId of ["j.masri", "r.haddad", "a.singh", "m.costa"]) {
      const res = await read(staffId);
      expect(res.statusCode, `${staffId}: ${res.body}`).toBe(200);
      const body = res.json();
      expect(body.followsPack, staffId).toBe(true);
      expect(body.accepted, staffId).toEqual(ALL);
      expect(body.canChange, staffId).toBe(staffId === "j.masri");
    }
    const body = (await read("m.costa")).json();
    expect(body.packId).toBe("pack-ca-v1");
    const health = body.types.find((t: { code: string }) => t.code === "health_card");
    expect(health).toMatchObject({ on: false, locked: true, packDefault: false, note: CANADA_HEALTH_CARD_NOTE });
    expect(body.types.filter((t: { locked: boolean }) => t.locked)).toHaveLength(1);
    expect(body.types.map((t: { kind: string }) => t.kind)).toEqual(ID_DOCUMENT_TYPES.map((row) => row.kind));
  });

  it("lets the owner switch types off, and writes one audit row naming them and no number", async () => {
    /* A customer already holding a National ID, so the row can count it. */
    const clientId = await openFile(`Accepted Audit ${randomUUID().slice(0, 8)}`);
    const added = await addDocument(clientId, { docType: "Emirates ID", docNumber: "784-AUDIT-PRIV", expiresOn: "2031-01-01" });
    expect(added.statusCode, added.body).toBe(201);
    const before = (await auditRows()).length;

    const res = await write("j.masri", WITHOUT_NATIONAL_ID.filter((code) => code !== "business_number"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ followsPack: false, canChange: true });
    expect(res.json().accepted).not.toContain("national_id_card");
    expect(res.json().accepted).not.toContain("business_number");
    expect(await stored()).toEqual(ALL.filter((code) => code !== "national_id_card" && code !== "business_number"));

    const rows = await auditRows();
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row.actor_id).toBe(`${DEMO.tenantId}:j.masri`);
    expect(row.reason).toContain("switched off National Identity Card, Business Number");
    expect(row.reason).toMatch(/\d+ IDs? on file (is|are) a type now switched off/);
    expect(row.reason).not.toContain("784-AUDIT-PRIV");

    /* Switching one back on is its own row. */
    const again = await write("j.masri", WITHOUT_NATIONAL_ID);
    expect(again.statusCode, again.body).toBe(200);
    expect((await auditRows()).at(-1)!.reason).toBe("accepted IDs: switched on Business Number");
  });

  it("refuses a manager and a teller with 403, and changes nothing", async () => {
    const before = (await auditRows()).length;
    for (const staffId of ["r.haddad", "m.costa", "a.singh"]) {
      const res = await write(staffId, WITHOUT_NATIONAL_ID);
      expect(res.statusCode, `${staffId}: ${res.body}`).toBe(403);
      expect(res.json()).toEqual({ code: "AUTHORIZATION_DENIED", message: OWNER_ONLY });
      const reset = await write(staffId, null);
      expect(reset.statusCode, staffId).toBe(403);
    }
    expect(await stored()).toBeNull();
    expect((await auditRows()).length).toBe(before);
    expect((await read("m.costa")).json().accepted).toEqual(ALL);
  });

  it("refuses to switch on a locked type, naming the legal note", async () => {
    const before = (await auditRows()).length;
    for (const name of ["health_card", "Health Card", "OHIP"]) {
      const res = await write("j.masri", [...ALL, name]);
      expect(res.statusCode, name).toBe(422);
      expect(res.json(), name).toEqual({
        code: "ID_TYPE_LOCKED",
        message: `Health Card can't be switched on. ${CANADA_HEALTH_CARD_NOTE}`,
      });
    }
    expect(await stored()).toBeNull();
    expect((await auditRows()).length).toBe(before);
  });

  it("refuses a list with no photo ID, and lets every business type go", async () => {
    for (const accepted of [[], ["business_number", "incorporation_certificate"], ["Business Number"]]) {
      const res = await write("j.masri", accepted);
      expect(res.statusCode, JSON.stringify(accepted)).toBe(422);
      expect(res.json()).toEqual({ code: "PHOTO_ID_REQUIRED", message: "Keep at least one photo ID switched on." });
    }
    expect(await stored()).toBeNull();

    const passportOnly = await write("j.masri", ["passport"]);
    expect(passportOnly.statusCode, passportOnly.body).toBe(200);
    expect(passportOnly.json().accepted).toEqual(["passport"]);
    expect(await stored()).toEqual(["passport"]);
  });

  it("refuses a name that is not a type, and a body that is not a list", async () => {
    const unknown = await write("j.masri", ["passport", "library_card"]);
    expect(unknown.statusCode).toBe(422);
    const sentence = "\"library_card\" isn't an ID type on the list.";
    expect(unknown.json()).toEqual({
      error: "ID_TYPE_NOT_IN_CATALOGUE", detail: sentence,
      code: "ID_TYPE_NOT_IN_CATALOGUE", message: sentence,
    });
    const shape = await app.inject({ method: "PUT", url: ROUTE, cookies: sessions["j.masri"], headers, payload: { accepted: "passport" } });
    expect(shape.statusCode).toBe(422);
    expect(await stored()).toBeNull();
  });

  it("hands the list back to the pack with null, or with the pack's own list", async () => {
    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);
    expect(await stored()).toEqual(WITHOUT_NATIONAL_ID);

    const reset = await write("j.masri", null);
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ followsPack: true, accepted: ALL });
    expect(await stored()).toBeNull();
    expect((await auditRows()).at(-1)!.reason).toBe("accepted IDs: switched on National Identity Card; following the pack");

    /* Switching every type back on by hand lands on the pack's defaults,
       so the shop follows the pack again rather than a frozen copy. */
    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);
    const byHand = await write("j.masri", [...ALL].reverse());
    expect(byHand.statusCode).toBe(200);
    expect(byHand.json().followsPack).toBe(true);
    expect(await stored()).toBeNull();
  });

  /* ------------------------------------------------------------------
     The customer file
     ------------------------------------------------------------------ */

  it("refuses to add a document of a type this shop has switched off", async () => {
    const clientId = await openFile(`Accepted Add ${randomUUID().slice(0, 8)}`);
    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);

    for (const docType of ["National Identity Card", "Emirates ID", "national_id_card"]) {
      const refused = await addDocument(clientId, { docType, docNumber: "784-ADD-PRIV", expiresOn: "2031-01-01" });
      expect(refused.statusCode, docType).toBe(422);
      expect(refused.json(), docType).toEqual({
        error: "ID_TYPE_NOT_ACCEPTED_HERE",
        detail: NOT_HERE,
        code: "ID_TYPE_NOT_ACCEPTED_HERE",
        message: NOT_HERE,
      });
    }
    const none = await pool.query("SELECT 1 FROM desk_client_identity_documents WHERE client_id=$1", [clientId]);
    expect(none.rowCount).toBe(0);

    /* What the shop does accept still saves, and so does the placeholder. */
    const passport = await addDocument(clientId, { docType: "Passport", docNumber: "PA-ADD-1", expiresOn: "2031-01-01" });
    expect(passport.statusCode, passport.body).toBe(201);
    const placeholder = await addDocument(clientId, { docType: "Not stated", isPrimary: false });
    expect(placeholder.statusCode, placeholder.body).toBe(201);
    /* A health card is still the health card refusal, not this one. */
    const health = await addDocument(clientId, { docType: "OHIP", docNumber: "HN-ADD-PRIV" });
    expect(health.json().code).toBe("HEALTH_CARD_NOT_ID");
  });

  it("names this shop's own types when a name is not on the list", async () => {
    const clientId = await openFile(`Accepted Unknown ${randomUUID().slice(0, 8)}`);
    const atDefaults = await addDocument(clientId, { docType: "Library card" });
    expect(atDefaults.json().detail).toBe(PACK_LIST);

    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);
    const narrowed = await addDocument(clientId, { docType: "Library card" });
    expect(narrowed.statusCode).toBe(422);
    expect(narrowed.json().code).toBe("ID_TYPE_NOT_IN_CATALOGUE");
    expect(narrowed.json().detail).toContain("Passport");
    expect(narrowed.json().detail).not.toContain("National Identity Card");
    expect(narrowed.json().detail).toBe(
      "That ID type isn't on this desk's list. Use one of: Driver's Licence, Passport, Provincial/Territorial Photo ID, " +
        "Permanent Resident Card, Secure Certificate of Indian Status, BC Services Card, Business Number, " +
        "Incorporation Certificate, Master Business Licence, or Articles of Incorporation.",
    );
  });

  it("refuses to change a document to a switched-off type, and still lets one be corrected", async () => {
    const clientId = await openFile(`Accepted Update ${randomUUID().slice(0, 8)}`);
    const passport = await addDocument(clientId, { docType: "Passport", docNumber: "PA-UPD-1", expiresOn: "2031-01-01" });
    const national = await addDocument(clientId, { docType: "National ID", docNumber: "784-UPD-1", expiresOn: "2031-01-01", isPrimary: false });
    expect(national.statusCode, national.body).toBe(201);
    const ids = Object.fromEntries(
      (national.json().documents as { docType: string; documentId: string }[]).map((d) => [d.docType, d.documentId]),
    );
    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);

    const toOff = await patchDocument(clientId, ids["Passport"]!, { docType: "Emirates ID" });
    expect(toOff.statusCode).toBe(422);
    expect(toOff.json()).toMatchObject({ error: "ID_TYPE_NOT_ACCEPTED_HERE", detail: NOT_HERE });
    const still = await pool.query("SELECT doc_type FROM desk_client_identity_documents WHERE document_id=$1", [ids["Passport"]]);
    expect(still.rows[0]!.doc_type).toBe("Passport");
    expect(passport.statusCode).toBe(201);

    /* The switched-off document itself: its own type sent back is not a
       change, and its number can be corrected. */
    const corrected = await patchDocument(clientId, ids["National Identity Card"]!, {
      docType: "National Identity Card", docNumber: "784-UPD-2",
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const row = await pool.query(
      "SELECT doc_type, doc_number FROM desk_client_identity_documents WHERE document_id=$1",
      [ids["National Identity Card"]],
    );
    expect(row.rows[0]).toEqual({ doc_type: "National Identity Card", doc_number: "784-UPD-2" });
  });

  it("still reads a switched-off ID on file, with its status and a quiet notice, and rewrites nothing", async () => {
    const name = `Accepted Kept ${randomUUID().slice(0, 8)}`;
    const clientId = await openFile(name);
    const added = await addDocument(clientId, { docType: "National Identity Card", docNumber: "784-KEPT-1", expiresOn: "2031-01-01" });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().verificationStatus).toBe("identified");
    expect(added.json().documents[0].notice).toBeNull();
    const before = await pool.query(
      "SELECT doc_type, doc_number, expires_on, is_primary, updated_at FROM desk_client_identity_documents WHERE client_id=$1",
      [clientId],
    );

    expect((await write("j.masri", WITHOUT_NATIONAL_ID)).statusCode).toBe(200);

    const one = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies: sessions["m.costa"], headers });
    const list = await app.inject({ method: "GET", url: "/api/clients", cookies: sessions["m.costa"], headers });
    const lookup = await app.inject({
      method: "GET", url: `/api/clients/lookup?name=${encodeURIComponent(name)}`, cookies: sessions["m.costa"], headers,
    });
    const reads = [
      ["get", one.json()],
      ["list", list.json().clients.find((c: { clientId: string }) => c.clientId === clientId)],
      ["lookup", lookup.json().clients[0]],
    ] as const;
    for (const [where, client] of reads) {
      expect(client.verificationStatus, where).toBe("identified");
      expect(client.documents, where).toHaveLength(1);
      expect(client.documents[0], where).toMatchObject({
        docType: "National Identity Card",
        docNumber: "784-KEPT-1",
        expiresOn: "2031-01-01",
        isPrimary: true,
        notice: NO_LONGER,
      });
    }
    /* The counter record still counts the document. */
    const counter = await pool.query("SELECT id_status FROM ledger_customers WHERE client_id=$1", [clientId]);
    expect(counter.rows.map((r) => r.id_status)).toContain("verified");

    const after = await pool.query(
      "SELECT doc_type, doc_number, expires_on, is_primary, updated_at FROM desk_client_identity_documents WHERE client_id=$1",
      [clientId],
    );
    expect(after.rows).toEqual(before.rows);

    /* Switched back on, the notice goes. */
    expect((await write("j.masri", null)).statusCode).toBe(200);
    const back = await app.inject({ method: "GET", url: `/api/clients/${clientId}`, cookies: sessions["m.costa"], headers });
    expect(back.json().documents[0].notice).toBeNull();
  });

  it("follows the pack when nothing is stated, whichever pack that is", async () => {
    const client = await pool.connect();
    try {
      const canada = await resolveAcceptedIdTypes(client, DEMO.legalEntityId);
      expect(canada).toMatchObject({ followsPack: true, accepted: ALL, packId: "pack-ca-v1" });

      const gb = await resolveAcceptedIdTypes(client, GB_ENTITY);
      expect(gb).toMatchObject({ followsPack: true, accepted: ALL, packId: "pack-gb-v2" });
      expect(gb.types.find((t) => t.code === "health_card")).toMatchObject({ locked: true, note: NEVER_ID_NOTE });

      /* A stored list is that list. */
      await pool.query("UPDATE legal_entities SET accepted_id_types=$2 WHERE id=$1", [GB_ENTITY, ["passport", "drivers_licence"]]);
      const narrowed = await resolveAcceptedIdTypes(client, GB_ENTITY);
      expect(narrowed).toMatchObject({ followsPack: false, accepted: ["drivers_licence", "passport"] });
      await pool.query("UPDATE legal_entities SET accepted_id_types=NULL WHERE id=$1", [GB_ENTITY]);
    } finally {
      client.release();
    }
  });

  it("holds the column to codes, and never an empty list", async () => {
    for (const bad of [[], ["Passport"], ["passport", "two words"]]) {
      await expect(
        pool.query("UPDATE legal_entities SET accepted_id_types=$2 WHERE id=$1", [GB_ENTITY, bad]),
        JSON.stringify(bad),
      ).rejects.toThrow(/accepted_id_types_check/);
    }
    await pool.query("UPDATE legal_entities SET accepted_id_types=$2 WHERE id=$1", [GB_ENTITY, ["passport", "bc_services_card"]]);
    await pool.query("UPDATE legal_entities SET accepted_id_types=NULL WHERE id=$1", [GB_ENTITY]);
  });
});
