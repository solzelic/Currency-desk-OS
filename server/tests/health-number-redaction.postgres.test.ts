/* The health-card review lists the clients and the deals. It does not
   list the number. Redaction replaces the number with a marker, keeps
   the row, writes one audit entry, and a second run writes nothing.
   Dry-run changes nothing. The command is not part of server boot. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { REDACTION_ACTION, REDACTION_REASON, REDACTED_HEALTH_NUMBER } from "../src/clients/health-numbers.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const OHIP = "HN-REPORT-OHIP-PRIV";
const CARE = "HN-REPORT-CARE-PRIV";
const VERIFIED_NUMBER = "HN-VERIFIED-STAYS-PRIV";
const PASSPORT = "PA-REPORT-KEEP";

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
const created: string[] = [];

const cookiesOf = (res: { cookies: { name: string; value: string }[]; statusCode: number }) => {
  expect(res.statusCode).toBe(200);
  const session = res.cookies.find((item) => item.name === "cdos_session");
  if (!session) throw new Error("sign-in did not set a session");
  return { cdos_session: session.value };
};

async function login(staffId: string) {
  return cookiesOf(await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  }));
}

async function openClient(name: string, cookies: Record<string, string>) {
  const made = await app.inject({
    method: "POST",
    url: "/api/clients",
    cookies,
    payload: { legalName: name },
  });
  expect(made.statusCode).toBe(201);
  const clientId = made.json().clientId as string;
  created.push(clientId);
  return clientId;
}

/* A new health card is refused with 422. Rows that are already stored
   are planted here, which is the state redaction exists for. */
async function plant(
  clientId: string,
  docType: string,
  docNumber: string,
  primary: boolean,
  jurisdiction: string | null,
  expiresOn: string,
) {
  const owner = await pool.query<{ tenant_id: string; legal_entity_id: string }>(
    "SELECT tenant_id, legal_entity_id FROM desk_clients WHERE client_id=$1",
    [clientId],
  );
  const row = owner.rows[0];
  if (!row) throw new Error(`no client ${clientId}`);
  const documentId = `doc_${randomUUID()}`;
  await pool.query(
    `INSERT INTO desk_client_identity_documents
      (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number,
       issuing_jurisdiction, expires_on, is_primary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'test')`,
    [documentId, clientId, row.tenant_id, row.legal_entity_id, docType, docNumber, jurisdiction, expiresOn, primary],
  );
  return documentId;
}

async function addPassport(clientId: string, docNumber: string, cookies: Record<string, string>) {
  const added = await app.inject({
    method: "POST",
    url: `/api/clients/${clientId}/documents`,
    cookies,
    payload: { docType: "Passport", docNumber, isPrimary: true },
  });
  expect(added.statusCode, added.body).toBe(201);
}

async function deal(id: string, clientId: string, name: string, reversed = false) {
  const customerId = `cust-${id}`;
  await pool.query(
    `INSERT INTO ledger_customers
      (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id, name, risk, id_status, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,'Normal','identified',$7)`,
    [customerId, DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, name, clientId],
  );
  await pool.query(
    `INSERT INTO ledger_transactions
      (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
       customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
       fee_cad, spread_cad, purpose, source_of_funds, posted_at,
       deal_kind, received_instrument, disbursed_instrument, home_currency)
     VALUES ($1,$2,$3,$4,$5,$6,'till-01',$7,$8,'CAD','USD',100,70,1.4,0,0,'Travel','Salary',now(),
             'exchange','cash','cash','CAD')`,
    [id, `ref-${id}`, DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, customerId, `${DEMO.tenantId}:j.masri`],
  );
  if (reversed) {
    await pool.query(
      `INSERT INTO ledger_reversals (reversal_id, transaction_id, actor_id, reason, posted_at)
       VALUES ($1,$2,$3,'mistaken',now())`,
      [`rev-${id}`, id, `${DEMO.tenantId}:j.masri`],
    );
  }
}

function cli(args: string[]) {
  return spawnSync("npx", ["tsx", "src/clients/redact-health-numbers-cli.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
}

postgres("health-card review and redaction", () => {
  let owner: Record<string, string>;
  let officer: Record<string, string>;
  let teller: Record<string, string>;
  let manager: Record<string, string>;
  let onlyId = "";
  let plusId = "";
  let markerId = "";
  let verifiedId = "";
  let healthDocIds: string[] = [];
  let priorTenant: { state: unknown; version: number } | null = null;
  let insertedTenant = false;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await seed(handle.db);
    app = await buildApp(handle.db);
    await pool.query(
      `INSERT INTO staff_users
        (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, authorized_branch_ids, password_hash, active)
       SELECT $1, tenant_id, legal_entity_id, branch_id, 'c.officer', 'C. Officer', 'compliance_officer',
              authorized_branch_ids, password_hash, true
         FROM staff_users WHERE id = $2`,
      [`${DEMO.tenantId}:c.officer`, `${DEMO.tenantId}:j.masri`],
    );
    owner = await login("j.masri");
    officer = await login("c.officer");
    teller = await login("m.costa");
    manager = await login("r.haddad");

    onlyId = await openClient("Health Only Report", owner);
    healthDocIds.push(await plant(onlyId, "OHIP", OHIP, true, "ON", "2030-04-01"));
    await pool.query("UPDATE desk_clients SET verification_status='identified' WHERE client_id=$1", [onlyId]);

    plusId = await openClient("Health Plus Passport", owner);
    await addPassport(plusId, PASSPORT, owner);
    healthDocIds.push(await plant(plusId, "Care Card", CARE, false, "BC", "2031-06-01"));

    const passportOnly = await openClient("Passport Only Report", owner);
    await addPassport(passportOnly, "PA-NOT-HEALTH", owner);

    markerId = await openClient("Marker Passport", owner);
    await addPassport(markerId, "PA-MARKER-BEFORE", owner);
    await pool.query(
      "UPDATE desk_client_identity_documents SET doc_number=$2 WHERE client_id=$1",
      [markerId, REDACTED_HEALTH_NUMBER],
    );
    await pool.query("UPDATE desk_clients SET verification_status='identified' WHERE client_id=$1", [markerId]);

    verifiedId = await openClient("Verified Health", owner);
    healthDocIds.push(await plant(verifiedId, "OHIP", VERIFIED_NUMBER, true, "ON", "2032-01-01"));
    await pool.query("UPDATE desk_clients SET verification_status='verified' WHERE client_id=$1", [verifiedId]);
    healthDocIds.sort();

    const existing = await pool.query<{ state: unknown; version: number }>(
      "SELECT state, version FROM tenant_state WHERE tenant_id=$1",
      [DEMO.tenantId],
    );
    const probe = JSON.stringify({
      idType: "Ontario Health Insurance Plan",
      idNum: OHIP,
      ids: [{ type: "Carte d'assurance maladie", num: CARE }],
    });
    if (existing.rowCount) {
      priorTenant = existing.rows[0]!;
      await pool.query(
        `UPDATE tenant_state
            SET state = jsonb_set(COALESCE(state, '{}'::jsonb), '{cdos_redaction_probe}', $2::jsonb, true)
          WHERE tenant_id=$1`,
        [DEMO.tenantId, probe],
      );
    } else {
      insertedTenant = true;
      await pool.query(
        "INSERT INTO tenant_state (tenant_id, state) VALUES ($1, $2::jsonb)",
        [DEMO.tenantId, JSON.stringify({ cdos_redaction_probe: JSON.parse(probe) })],
      );
    }
    await deal("tx-hn-posted", onlyId, "Health Only Report");
    await deal("tx-hn-reversed", onlyId, "Health Only Report", true);
    await deal("tx-hn-passport", plusId, "Health Plus Passport");
  });

  afterAll(async () => {
    /* Posted deals and audit rows are append-only. This database is
       disposable. The client rows are not, and they cascade to the
       documents the command rewrote. */
    if (priorTenant) {
      await pool.query("UPDATE tenant_state SET state=$2::jsonb, version=$3 WHERE tenant_id=$1", [
        DEMO.tenantId,
        JSON.stringify(priorTenant.state),
        priorTenant.version,
      ]);
    } else if (insertedTenant) {
      await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    }
    if (created.length) {
      await pool.query("DELETE FROM desk_clients WHERE client_id = ANY($1::text[])", [created]);
    }
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  it("lists the health-card clients and the deals that relied on one, and not the number", async () => {
    const review = await app.inject({ method: "GET", url: "/api/clients/health-card-review", cookies: owner });
    expect(review.statusCode).toBe(200);
    const body = review.json();
    expect(JSON.stringify(body)).not.toContain(OHIP);
    expect(JSON.stringify(body)).not.toContain(CARE);
    const names = (body.clients as { legalName: string; clientId: string; documents: { numberStatus: string; docType: string }[] }[])
      .map((client) => client.legalName).sort();
    expect(names).toEqual(["Health Only Report", "Health Plus Passport", "Verified Health"]);
    const only = (body.clients as { clientId: string; documents: { docType: string; issuingJurisdiction: string | null; numberStatus: string }[] }[])
      .find((client) => client.clientId === onlyId);
    expect(only?.documents[0]).toMatchObject({ docType: "OHIP", issuingJurisdiction: "ON", numberStatus: "stored" });
    const refs = (body.deals as { transactionRef: string; clientId: string }[]).map((deal) => deal.transactionRef);
    expect(refs).toEqual(["ref-tx-hn-posted"]);
    expect(refs).not.toContain("ref-tx-hn-reversed");
    expect(refs).not.toContain("ref-tx-hn-passport");
    expect((body.deals as { clientId: string }[])[0]?.clientId).toBe(onlyId);

    expect((await app.inject({ method: "GET", url: "/api/clients/health-card-review", cookies: officer })).statusCode).toBe(200);
    for (const cookies of [teller, manager]) {
      const denied = await app.inject({ method: "GET", url: "/api/clients/health-card-review", cookies });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("HEALTH_REVIEW_FORBIDDEN");
    }
  });

  it("dry-run changes nothing, and apply is refused without an owner", async () => {
    const before = await pool.query("SELECT doc_number FROM desk_client_identity_documents WHERE client_id = $1", [onlyId]);
    const auditsBefore = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action = $1",
      [REDACTION_ACTION],
    );
    const dry = cli(["--actor", "j.masri"]);
    expect(dry.status, dry.stderr + dry.stdout).toBe(0);
    expect(dry.stdout).toContain("dry-run: nothing was changed");
    expect(dry.stdout).toContain("health numbers still stored: 3");
    expect(dry.stdout).toContain("posted deals that relied on a health card: 1");
    expect(dry.stdout).toContain("document ids:");
    expect(dry.stdout).toContain("filings and scans were not changed. Compliance is ruling on them.");
    for (const documentId of healthDocIds) expect(dry.stdout).toContain(documentId);
    expect(dry.stdout).not.toContain(OHIP);
    expect(dry.stdout).not.toContain(CARE);
    expect(dry.stdout).not.toContain(VERIFIED_NUMBER);
    const tenant = await pool.query("SELECT state::text AS state FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    expect(tenant.rows[0]!.state).toContain(OHIP);
    const after = await pool.query("SELECT doc_number FROM desk_client_identity_documents WHERE client_id = $1", [onlyId]);
    expect(after.rows).toEqual(before.rows);
    const auditsAfter = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action = $1",
      [REDACTION_ACTION],
    );
    expect(auditsAfter.rows[0].n).toBe(auditsBefore.rows[0].n);

    const missing = cli(["--apply"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--actor");
    const tellerRun = cli(["--apply", "--actor", "m.costa"]);
    expect(tellerRun.status, tellerRun.stderr).not.toBe(0);
    expect(tellerRun.stderr).toContain("Only the owner or the compliance officer");
    const still = await pool.query("SELECT doc_number FROM desk_client_identity_documents WHERE doc_number = $1", [OHIP]);
    expect(still.rowCount).toBe(1);
  });

  it("replaces the number, keeps the row, writes the audit entry, and is idempotent", async () => {
    const before = await pool.query(
      `SELECT doc_type, issuing_jurisdiction, expires_on::text, created_by, created_at
         FROM desk_client_identity_documents WHERE client_id = $1`,
      [onlyId],
    );
    const readBefore = await app.inject({ method: "GET", url: `/api/clients/${onlyId}`, cookies: owner });
    expect(readBefore.json().verificationStatus).toBe("unverified");
    const columnBefore = await pool.query("SELECT verification_status FROM desk_clients WHERE client_id=$1", [onlyId]);
    expect(columnBefore.rows[0]!.verification_status).toBe("identified");

    const applied = cli(["--apply", "--actor", "j.masri"]);
    expect(applied.status, applied.stderr + applied.stdout).toBe(0);
    expect(applied.stdout).toContain("redacted: 3");
    expect(applied.stdout).toContain("filings and scans were not changed. Compliance is ruling on them.");
    for (const documentId of healthDocIds) expect(applied.stdout).toContain(documentId);
    expect(applied.stdout).not.toContain(OHIP);
    expect(applied.stdout).not.toContain(CARE);
    expect(applied.stdout).not.toContain(VERIFIED_NUMBER);

    const row = await pool.query(
      `SELECT doc_type, doc_number, issuing_jurisdiction, expires_on::text, created_by, created_at, updated_by
         FROM desk_client_identity_documents WHERE client_id = $1`,
      [onlyId],
    );
    expect(row.rows[0]).toMatchObject({
      doc_type: before.rows[0].doc_type,
      doc_number: REDACTED_HEALTH_NUMBER,
      issuing_jurisdiction: "ON",
      expires_on: "2030-04-01",
      created_by: before.rows[0].created_by,
      updated_by: `${DEMO.tenantId}:j.masri`,
    });
    expect(new Date(row.rows[0].created_at).toISOString()).toBe(new Date(before.rows[0].created_at).toISOString());

    const passport = await pool.query(
      "SELECT doc_number FROM desk_client_identity_documents WHERE client_id = $1 AND doc_type = 'Passport'",
      [plusId],
    );
    expect(passport.rows[0].doc_number).toBe(PASSPORT);

    const documents = await pool.query(
      "SELECT document_id FROM desk_client_identity_documents WHERE document_id = ANY($1::text[]) AND doc_number = $2",
      [healthDocIds, REDACTED_HEALTH_NUMBER],
    );
    expect(documents.rowCount).toBe(healthDocIds.length);
    const audit = await pool.query(
      "SELECT actor_id, action, reason, target_id, created_at FROM ledger_audit_events WHERE action = $1 ORDER BY target_id",
      [REDACTION_ACTION],
    );
    expect(audit.rowCount).toBe(healthDocIds.length);
    expect(audit.rows.map((event) => event.target_id).sort()).toEqual([...healthDocIds].sort());
    for (const event of audit.rows) {
      expect(event.action).toBe(REDACTION_ACTION);
      expect(event.actor_id).toBe(`${DEMO.tenantId}:j.masri`);
      expect(event.reason).toBe(REDACTION_REASON);
      expect(event.reason).toBe("health number not lawful to keep, not valid ID");
      expect(event.reason).not.toContain(OHIP);
      expect(event.reason).not.toContain(CARE);
      expect(event.created_at).toBeTruthy();
      expect(Number.isNaN(new Date(event.created_at).getTime())).toBe(false);
    }

    const opened = await app.inject({ method: "GET", url: `/api/clients/${onlyId}`, cookies: owner });
    expect(opened.statusCode).toBe(200);
    const document = (opened.json().documents as { docType: string; docNumber?: string }[])
      .find((item) => item.docType === "OHIP");
    expect(document).toBeTruthy();
    expect(document).not.toHaveProperty("docNumber");
    expect(opened.json().verificationStatus).toBe("unverified");
    expect(JSON.stringify(opened.json())).not.toContain(OHIP);
    const columnAfter = await pool.query("SELECT verification_status FROM desk_clients WHERE client_id=$1", [onlyId]);
    expect(columnAfter.rows[0]!.verification_status).toBe("unverified");

    const marked = await app.inject({ method: "GET", url: `/api/clients/${markerId}`, cookies: owner });
    expect(marked.json().verificationStatus).toBe("unverified");
    const markedColumn = await pool.query("SELECT verification_status FROM desk_clients WHERE client_id=$1", [markerId]);
    expect(markedColumn.rows[0]!.verification_status).toBe("unverified");
    const markedNumber = await pool.query(
      "SELECT doc_number FROM desk_client_identity_documents WHERE client_id=$1",
      [markerId],
    );
    expect(markedNumber.rows[0]!.doc_number).toBe(REDACTED_HEALTH_NUMBER);

    const keptVerified = await app.inject({ method: "GET", url: `/api/clients/${verifiedId}`, cookies: owner });
    expect(keptVerified.json().verificationStatus).toBe("verified");
    expect(JSON.stringify(keptVerified.json())).not.toContain(VERIFIED_NUMBER);
    const verifiedColumn = await pool.query("SELECT verification_status FROM desk_clients WHERE client_id=$1", [verifiedId]);
    expect(verifiedColumn.rows[0]!.verification_status).toBe("verified");

    const plus = await app.inject({ method: "GET", url: `/api/clients/${plusId}`, cookies: owner });
    expect(plus.json().verificationStatus).toBe("identified");

    const tenant = await pool.query("SELECT state::text AS state FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    expect(tenant.rows[0]!.state).not.toContain(OHIP);
    expect(tenant.rows[0]!.state).not.toContain(CARE);

    const again = cli(["--apply", "--actor", "j.masri"]);
    expect(again.status, again.stderr + again.stdout).toBe(0);
    expect(again.stdout).toContain("redacted: 0");
    expect(again.stdout).toContain("already redacted: 3");
    expect(again.stdout).toContain("document ids: none");
    const auditAfter = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action = $1",
      [REDACTION_ACTION],
    );
    expect(auditAfter.rows[0].n).toBe(3);

    const review = await app.inject({ method: "GET", url: "/api/clients/health-card-review", cookies: officer });
    expect(review.statusCode).toBe(200);
    expect(JSON.stringify(review.json())).not.toContain(OHIP);
    expect(JSON.stringify(review.json())).not.toContain(CARE);
    const still = (review.json().clients as { clientId: string; documents: { numberStatus: string }[] }[])
      .find((client) => client.clientId === onlyId);
    expect(still?.documents[0]?.numberStatus).toBe("redacted");
    expect((review.json().deals as { transactionRef: string }[]).map((item) => item.transactionRef)).toEqual(["ref-tx-hn-posted"]);
  });

  it("does not run redaction on boot, and the review route is live", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const migrations = readFileSync(new URL("../src/db/migrations.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../src/clients/routes.ts", import.meta.url), "utf8");
    expect(index).not.toContain("redact-health-numbers");
    expect(index).not.toContain("health-numbers");
    expect(migrations).not.toContain("redact");
    expect(migrations).not.toContain("health-card");
    expect(routes).toContain('from "./health-numbers.js"');
    expect(routes).toContain('"/api/clients/health-card-review"');
  });
});
