/* ============================================================
   The filed copy of a regulatory report, where it can actually be kept.

   An exploratory pass filed three reports through the desk and then asked
   the database what it had. `ledger_report_filings`: no rows. The table had
   been built, given an immutability trigger and an `amends_filing_id`
   column, and never written to — every filing the product had ever made
   lived in one browser's localStorage, under a sealed PDF that printed
   "Retain >= 5 years per FINTRAC record-keeping" over it.

   Three defects came out of that, and each has tests here.

     · Nothing reached the database at all.
     · A re-filed report overwrote the first one, so two submissions to the
       regulator carrying two different acknowledgement numbers left the
       desk holding one record and the earlier sealed copy destroyed.
     · A filed aggregate silently absorbed later transactions: a report over
       four cash-ins went on claiming to cover the same person's fifth and
       sixth, under an acknowledgement that never mentioned them.

   The last one is the reason a filing is identified by WHAT IT COVERS and
   not by who and when.
   ============================================================ */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

async function cookie(staffId = "r.haddad") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

/* One four-deal aggregate over Rachel Carter's Tuesday, in the shape the
   worksheet seals: the obligation carries a fingerprint of its transaction
   set, the group carries only who and when. */
const AGGREGATE = {
  reportCode: "LCTR",
  obligationId: "AGG-LCTR-C-Rachel_Carter-2026-08-04-4KQ8ZP",
  obligationGroupId: "AGG-LCTR-C-Rachel_Carter-2026-08-04",
  reportRef: "LCTR-2026-9F2A1",
  subjectName: "Rachel Carter",
  reportedAmount: "11600.00",
  reportedCurrency: "CAD",
  transactionRefs: ["YFX-1001", "YFX-1002", "YFX-1003", "YFX-1004"],
  aggregationBasis: "conductor",
  windowStart: "2026-08-04T00:00:00-04:00",
  windowEnd: "2026-08-05T00:00:00-04:00",
  acknowledgementRef: "FWR-AGG-RC-0001",
  payload: { narrative: "ORIGINAL", fields: { sa_deposit: "N" } },
  amendsFilingId: null,
};

async function file(body: Record<string, unknown>, staffId = "r.haddad") {
  return app.inject({
    method: "POST",
    url: "/api/ledger/report-filings",
    cookies: await cookie(staffId),
    payload: body,
  });
}

async function resetLedger() {
  await pool.query(
    "TRUNCATE ledger_report_filings,ledger_audit_events,ledger_principals CASCADE",
  );
  const scope = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES
      ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
      ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
    scope,
  );
}

/* The legal entity, in the LEDGER database. In production this is one
   database holding both halves; the test harness splits them, so the pack
   an entity operates under has to be stated on this side for the filing
   path to resolve the same form a real desk would. */
async function entityUnderPack(packId: string) {
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York Currency Exchange Inc.','x','CAD',$3,1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id=EXCLUDED.jurisdiction_pack_id`,
    [DEMO.legalEntityId, DEMO.tenantId, packId],
  );
}

postgres("filed regulatory reports against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "branch_manager" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
    await resetLedger();
    await entityUnderPack("pack-ca-v1");
  });

  it("writes the sealed report to the database, not to a browser", async () => {
    const response = await file(AGGREGATE);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "filed",
      reportCode: "LCTR",
      acknowledgementRef: "FWR-AGG-RC-0001",
      obligationId: AGGREGATE.obligationId,
    });

    /* The database, not the response. The whole defect was a screen saying
       "sealed" over a table with no rows in it. */
    const rows = await pool.query(
      "SELECT * FROM ledger_report_filings WHERE tenant_id=$1",
      [DEMO.tenantId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      status: "filed",
      report_id: "rpt-ca-lctr",
      pack_id: "pack-ca-v1",
      report_code: "LCTR",
      subject_name: "Rachel Carter",
      acknowledgement_ref: "FWR-AGG-RC-0001",
      obligation_group_id: AGGREGATE.obligationGroupId,
    });
    // every field AS SUBMITTED, kept whole
    expect(rows.rows[0].payload).toMatchObject({ narrative: "ORIGINAL" });
    expect(rows.rows[0].subject_transaction_ids).toEqual(AGGREGATE.transactionRefs);
    expect(rows.rows[0].filed_by).toBe(`${DEMO.tenantId}:r.haddad`);
    // and the act of filing is in the trail beside the ones that move money
    const audit = await pool.query(
      "SELECT action,reason FROM ledger_audit_events WHERE action LIKE 'report.%'",
    );
    expect(audit.rows[0]).toMatchObject({ action: "report.file" });
  });

  it("refuses a second unlinked filing of the same obligation", async () => {
    expect((await file(AGGREGATE)).statusCode).toBe(201);
    const again = await file({
      ...AGGREGATE,
      acknowledgementRef: "FWR-AGG-RC-0002",
      payload: { narrative: "REWRITTEN" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("OBLIGATION_ALREADY_FILED");

    // and the first copy is untouched — one row, still saying ORIGINAL
    const rows = await pool.query("SELECT payload FROM ledger_report_filings");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].payload).toMatchObject({ narrative: "ORIGINAL" });
  });

  it("keeps both copies when a filing is corrected", async () => {
    const first = await file(AGGREGATE);
    const firstId = first.json().filingId;

    const correction = await file({
      ...AGGREGATE,
      obligationId: `${AGGREGATE.obligationId}-v2`,
      acknowledgementRef: "FWR-AGG-RC-0002",
      payload: { narrative: "REWRITTEN" },
      amendsFilingId: firstId,
    });
    expect(correction.statusCode).toBe(201);
    expect(correction.json().amendsFilingId).toBe(firstId);

    /* TWO submissions to the regulator, TWO acknowledgement numbers, TWO
       records. The old behaviour left one, and deleted the sealed copy of
       the report that had actually been sent first. */
    const rows = await pool.query(
      "SELECT filing_id,acknowledgement_ref,payload,amends_filing_id FROM ledger_report_filings ORDER BY created_at",
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0].payload).toMatchObject({ narrative: "ORIGINAL" });
    expect(rows.rows[0].acknowledgement_ref).toBe("FWR-AGG-RC-0001");
    expect(rows.rows[1].payload).toMatchObject({ narrative: "REWRITTEN" });
    expect(rows.rows[1].amends_filing_id).toBe(firstId);

    /* Nothing marks the first row as superseded, because nothing can — it
       is sealed. The reader derives it, which is the only answer that
       stays true. */
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings",
      cookies: await cookie(),
    });
    const byId = Object.fromEntries(
      listed.json().filings.map((f: { filingId: string }) => [f.filingId, f]),
    );
    expect(byId[firstId].amendedByFilingId).toBe(correction.json().filingId);
    expect(byId[correction.json().filingId].amendedByFilingId).toBeNull();
  });

  it("refuses a correction that names a filing this desk does not hold", async () => {
    const orphan = await file({
      ...AGGREGATE,
      obligationId: `${AGGREGATE.obligationId}-v2`,
      amendsFilingId: "00000000-0000-0000-0000-000000000000",
    });
    expect(orphan.statusCode).toBe(422);
    expect(orphan.json().code).toBe("AMENDED_FILING_NOT_FOUND");
    expect((await pool.query("SELECT 1 FROM ledger_report_filings")).rowCount).toBe(0);
  });

  it("will not let a filed report be edited or deleted, by anyone", async () => {
    await file(AGGREGATE);
    /* Not through the API — there is no route that tries. Straight at the
       table, which is where the guarantee has to live: a filed report is
       evidence, and the desk's own database is the last thing standing
       between it and a well-meaning UPDATE. */
    await expect(
      pool.query("UPDATE ledger_report_filings SET acknowledgement_ref='TAMPERED'"),
    ).rejects.toThrow(/filed report is sealed/);
    await expect(
      pool.query("DELETE FROM ledger_report_filings"),
    ).rejects.toThrow(/filed report is sealed/);
    const rows = await pool.query(
      "SELECT acknowledgement_ref FROM ledger_report_filings",
    );
    expect(rows.rows[0].acknowledgement_ref).toBe("FWR-AGG-RC-0001");
  });

  it("treats an aggregate that has grown as a new obligation linked to the old one", async () => {
    /* THE ONE THAT MATTERS. Four cash-ins were filed. The same person came
       back twice more the same day. The desk used to go on reading
       "6 cash-ins · $16,600 · filed FWR-AGG-RC-0001" over a sealed copy
       covering $14,100 — reportable cash presented as filed under an
       acknowledgement that never covered it. */
    const first = await file(AGGREGATE);
    const grown = await file({
      ...AGGREGATE,
      // same person, same day, DIFFERENT transaction set — so a different
      // obligation, and the fingerprint in the id is what says so
      obligationId: "AGG-LCTR-C-Rachel_Carter-2026-08-04-QQ31MB",
      reportedAmount: "16600.00",
      transactionRefs: [...AGGREGATE.transactionRefs, "YFX-1005", "YFX-1006"],
      acknowledgementRef: "FWR-AGG-RC-0007",
      payload: { narrative: "SIX DEALS" },
      amendsFilingId: first.json().filingId,
    });
    expect(grown.statusCode).toBe(201);

    /* Both are on the record, they share a group, and between them every
       one of the six deals is named on something filed. */
    const group = await pool.query(
      `SELECT acknowledgement_ref, subject_transaction_ids, amends_filing_id
         FROM ledger_report_filings
        WHERE obligation_group_id=$1 ORDER BY created_at`,
      [AGGREGATE.obligationGroupId],
    );
    expect(group.rowCount).toBe(2);
    expect(group.rows[1].amends_filing_id).toBe(first.json().filingId);
    const covered = new Set(
      group.rows.flatMap((row) => row.subject_transaction_ids as string[]),
    );
    expect([...covered].sort()).toEqual([
      "YFX-1001", "YFX-1002", "YFX-1003", "YFX-1004", "YFX-1005", "YFX-1006",
    ]);
    // and the earlier filing still says what it said: four deals, $11,600
    expect(group.rows[0].subject_transaction_ids).toHaveLength(4);
  });

  it("will not seal a filing with no acknowledgement to show for it", async () => {
    const blank = await file({ ...AGGREGATE, acknowledgementRef: "  " });
    expect(blank.statusCode).toBe(400);
    /* And the database says the same thing, so no future path can write one
       either. A filed report with no acknowledgement is a desk asserting it
       filed with nothing an examiner can check. */
    await expect(
      pool.query(
        `INSERT INTO ledger_report_filings
           (filing_id,tenant_id,legal_entity_id,branch_id,report_id,pack_id,
            pack_version,report_code,status,payload,created_by)
         VALUES ('f-noack',$1,$2,$3,'rpt-ca-lctr','pack-ca-v1',1,'LCTR','filed','{}','x')`,
        [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
      ),
    ).rejects.toThrow(/ledger_report_filings_ack_required/);
  });

  it("shows a filing to a session that did not file it", async () => {
    /* Two tills meant two disjoint sets of filings, because the record was
       a browser. This is the same entity seen by somebody else. */
    const sealed = await file(AGGREGATE, "r.haddad");
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings",
      cookies: await cookie("a.singh"),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().filings).toHaveLength(1);
    // the list deliberately leaves the payload out; the copy itself is a
    // second call, and it comes back whole
    expect(listed.json().filings[0].payload).toBeUndefined();
    const copy = await app.inject({
      method: "GET",
      url: `/api/ledger/report-filings/${sealed.json().filingId}`,
      cookies: await cookie("a.singh"),
    });
    expect(copy.json().payload).toMatchObject({ narrative: "ORIGINAL" });
  });

  it("keeps one entity's filings away from another's", async () => {
    await file(AGGREGATE);
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ('tnt-other','other') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ('le-other','tnt-other','Other','x','CAD','pack-ca-v1',1) ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO ledger_report_filings
         (filing_id,tenant_id,legal_entity_id,branch_id,report_id,pack_id,pack_version,
          report_code,status,payload,acknowledgement_ref,created_by,obligation_id)
       VALUES ('f-other','tnt-other','le-other','br-other','rpt-ca-lctr','pack-ca-v1',1,
               'LCTR','filed','{"narrative":"SOMEBODY ELSE"}','ACK-OTHER','x','o-1')`,
    );
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings",
      cookies: await cookie(),
    });
    expect(listed.json().filings).toHaveLength(1);
    expect(listed.json().filings[0].subjectName).toBe("Rachel Carter");
    const reach = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings/f-other",
      cookies: await cookie(),
    });
    expect(reach.statusCode).toBe(404);
  });

  it("lets an auditor read what the desk filed and not file in its name", async () => {
    await file(AGGREGATE);
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "auditor" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings",
      cookies: await cookie(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().filings).toHaveLength(1);
    const refused = await file({
      ...AGGREGATE,
      obligationId: `${AGGREGATE.obligationId}-x`,
      acknowledgementRef: "ACK-AUDITOR",
    });
    expect(refused.statusCode).toBe(403);
    expect((await pool.query("SELECT 1 FROM ledger_report_filings")).rowCount).toBe(1);
  });

  it("files the form the desk's own jurisdiction pack has, and no other", async () => {
    /* The point of the packs. A London desk files an MLR; the same code
       path, the same table, a different row of `jurisdiction_reports`. And
       a form the pack does not contain is refused rather than invented —
       the same discipline as seeding empty field lists in migration 012. */
    await entityUnderPack("pack-gb-v1");
    const mlr = await file({
      ...AGGREGATE,
      reportCode: "MLR",
      reportedCurrency: "GBP",
      obligationId: "STR-Brooke_Lawson-7X2QQ1",
      obligationGroupId: "STR-Brooke_Lawson",
      subjectName: "Brooke Lawson",
      acknowledgementRef: "NCA-0001",
    });
    expect(mlr.statusCode).toBe(201);
    expect(mlr.json()).toMatchObject({
      reportId: "rpt-gb-mlr",
      packId: "pack-gb-v1",
      reportCode: "MLR",
    });

    const wrongCountry = await file({
      ...AGGREGATE,
      obligationId: `${AGGREGATE.obligationId}-gb`,
      acknowledgementRef: "NCA-0002",
    });
    expect(wrongCountry.statusCode).toBe(422);
    expect(wrongCountry.json().code).toBe("REPORT_NOT_IN_PACK");
  });
});
