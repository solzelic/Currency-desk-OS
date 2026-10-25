/* Who may file, who may read an STR, and who may open the watch.
   A teller and an auditor get no filing. A supervisor may file and
   read an LCTR and may not see an STR. The three compliance roles
   may do both. The watch list and acknowledge stop at supervisor. */
import pg from "pg";
import { eq } from "drizzle-orm";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hasBackendPermission } from "../src/auth/permissions.js";
import { createDb, provisionPostgres, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const roles = createRequire(import.meta.url)("../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  canSeeStructuringWatch: (role: string) => boolean;
  canReleaseFiling: (role: string, code: string) => boolean;
};
const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const STR = ["administrator", "branch_manager", "compliance_officer"];
const WATCH = [...STR, "supervisor"];
const HIDDEN = ["strTag", "strLink", "structuring", "structuringTotal", "ackStr", "ackStrInfo"];

describe("str and watch role sets", () => {
  it("keeps STR to the three roles and the watch to those three plus supervisor", () => {
    for (const role of STR) {
      expect(roles.canSeeStr(role), role).toBe(true);
      expect(roles.canSeeStructuringWatch(role), role).toBe(true);
    }
    expect(roles.canSeeStr("supervisor")).toBe(false);
    expect(roles.canSeeStructuringWatch("supervisor")).toBe(true);
    for (const role of ["teller", "auditor", "Owner", "Cashier", "", "nope"]) {
      expect(roles.canSeeStr(role), role).toBe(false);
      expect(roles.canSeeStructuringWatch(role), role).toBe(false);
    }
    expect(roles.canReleaseFiling("supervisor", "LCTR")).toBe(true);
    expect(roles.canReleaseFiling("supervisor", "lctr")).toBe(true);
    expect(roles.canReleaseFiling("supervisor", "STR")).toBe(false);
    expect(roles.canReleaseFiling("supervisor", "MLR")).toBe(false);
    expect(roles.canReleaseFiling("teller", "LCTR")).toBe(false);
    expect(roles.canReleaseFiling("administrator", "STR")).toBe(true);
    expect(roles.canReleaseFiling("branch_manager", "EFTR")).toBe(true);
  });

  it("removes compliance:file from a teller and an auditor and grants filing:view from supervisor up", () => {
    expect(hasBackendPermission("teller", "compliance:file")).toBe(false);
    expect(hasBackendPermission("auditor", "compliance:file")).toBe(false);
    for (const role of ["teller", "auditor"]) {
      expect(hasBackendPermission(role, "filing:view"), role).toBe(false);
    }
    for (const role of WATCH) expect(hasBackendPermission(role, "filing:view"), role).toBe(true);
    for (const role of WATCH) expect(hasBackendPermission(role, "compliance:file"), role).toBe(true);
  });
});

let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];

async function cookie(staffId = "m.costa") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function asRole(role: string) {
  await handle.db.update(schema.staffUsers).set({ role: role as "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  return cookie();
}

function filing(code: string, mark: string) {
  return {
    reportCode: code,
    obligationId: `STR-ROLE-${code}-${mark}`,
    obligationGroupId: `STR-ROLE-${code}`,
    reportRef: `REF-${code}-${mark}`,
    subjectName: code === "STR" ? "Nora Quinn" : "Rachel Carter",
    reportedAmount: "6000.00",
    reportedCurrency: "CAD",
    transactionRefs: code === "STR" ? ["YFX-STR-1"] : ["YFX-STR-2"],
    aggregationBasis: "conductor",
    windowStart: "2026-10-20T00:00:00-04:00",
    windowEnd: "2026-10-21T00:00:00-04:00",
    acknowledgementRef: `ACK-${code}-${mark}`,
    payload: { narrative: mark },
    amendsFilingId: null,
  };
}

postgres("str filing, transaction strip, watch, and acknowledge", () => {
  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = await provisionPostgres(url!);
    handle = await createDb();
    await seed(handle.db);
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX','FINTRAC','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD', jurisdiction_pack_version=1`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query("TRUNCATE ledger_structuring_acks, ledger_filing_flags, ledger_report_filings, ledger_audit_events, ledger_transactions, ledger_customers, ledger_principals CASCADE");
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ledger_structuring_acks, ledger_filing_flags, ledger_report_filings, ledger_audit_events, ledger_transactions, ledger_customers, ledger_principals CASCADE");
    await handle.db.update(schema.staffUsers).set({ role: "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
    await pool.query(
      "INSERT INTO ledger_customers (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status) VALUES ('cust-watch',$1,$2,$3,$4,'Nora Quinn','Normal','verified')",
      scope.slice(0, 4),
    );
    for (const [id, ref] of [["tx-str-1", "YFX-STR-1"], ["tx-str-2", "YFX-STR-2"]] as const) {
      await pool.query(
        `INSERT INTO ledger_transactions
           (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,
            from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at,
            deal_kind,received_instrument,disbursed_instrument,cash_in_home)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'cust-watch',$3||':j.masri','CAD','USD',6000,4400,0.73,0,0,'Travel money','Employment income',now(),
                 'exchange','cash','cash',6000)`,
        [id, ref, ...scope],
      );
    }
  });

  it("files and reads STR and LCTR only for the roles that may", async () => {
    const owner = await cookie("j.masri");
    const sealed = await app.inject({ method: "POST", url: "/api/ledger/report-filings", cookies: owner, payload: filing("STR", "seed") });
    expect(sealed.statusCode, sealed.body).toBe(201);
    const lctr = await app.inject({ method: "POST", url: "/api/ledger/report-filings", cookies: owner, payload: filing("LCTR", "seed") });
    expect(lctr.statusCode, lctr.body).toBe(201);
    const strId = sealed.json().filingId as string;
    const lctrId = lctr.json().filingId as string;
    const matrix = [
      ["teller", false, false],
      ["auditor", false, false],
      ["supervisor", false, true],
      ["compliance_officer", true, true],
      ["branch_manager", true, true],
      ["administrator", true, true],
    ] as const;
    for (const [role, strOk, lctrOk] of matrix) {
      const cookies = await asRole(role);
      const listed = await app.inject({ method: "GET", url: "/api/ledger/report-filings", cookies });
      const openStr = await app.inject({ method: "GET", url: `/api/ledger/report-filings/${strId}`, cookies });
      const openLctr = await app.inject({ method: "GET", url: `/api/ledger/report-filings/${lctrId}`, cookies });
      const postStr = await app.inject({ method: "POST", url: "/api/ledger/report-filings", cookies, payload: filing("STR", role) });
      const postLctr = await app.inject({ method: "POST", url: "/api/ledger/report-filings", cookies, payload: filing("LCTR", role) });
      if (!strOk && !lctrOk) {
        expect(listed.statusCode, role).toBe(403);
        expect(listed.body, role).not.toContain("Nora Quinn");
        expect(listed.body, role).not.toContain("Rachel Carter");
        expect(openStr.statusCode, role).toBe(403);
        expect(openLctr.statusCode, role).toBe(403);
      } else {
        expect(listed.statusCode, role).toBe(200);
        const codes = listed.json().filings.map((row: { reportCode: string }) => row.reportCode);
        expect(codes.includes("STR"), role).toBe(strOk);
        expect(codes.includes("LCTR"), role).toBe(lctrOk);
        expect(openStr.statusCode, role).toBe(strOk ? 200 : 404);
        expect(openLctr.statusCode, role).toBe(200);
        if (!strOk) expect(openStr.body, role).not.toContain("Nora Quinn");
      }
      expect(postStr.statusCode, role).toBe(strOk ? 201 : 403);
      expect(postLctr.statusCode, role).toBe(lctrOk ? 201 : 403);
      if (!strOk) {
        const strRows = await pool.query("SELECT count(*)::int AS n FROM ledger_report_filings WHERE upper(report_code)='STR'");
        expect(strRows.rows[0].n, role).toBe(1);
      }
    }
  });

  it("strips the STR tag, the STR link, and the structuring fields from a role that cannot see them", async () => {
    const owner = await cookie("j.masri");
    const sealed = await app.inject({ method: "POST", url: "/api/ledger/report-filings", cookies: owner, payload: filing("STR", "tag") });
    expect(sealed.statusCode, sealed.body).toBe(201);
    const teller = await (await app.inject({ method: "GET", url: "/api/ledger/transactions", cookies: await asRole("teller") })).json();
    const supervisor = await (await app.inject({ method: "GET", url: "/api/ledger/transactions", cookies: await asRole("supervisor") })).json();
    const admin = await (await app.inject({ method: "GET", url: "/api/ledger/transactions", cookies: await asRole("administrator") })).json();
    const body = JSON.stringify(teller);
    for (const key of HIDDEN) expect(body, key).not.toContain(`"${key}"`);
    expect(body).not.toContain("cash_in_home");
    expect(body).not.toContain("cashInHome");
    expect(body).toContain("Travel money");
    expect(body).toContain("YFX-STR-1");
    const sup = supervisor.transactions.find((row: { transactionRef: string }) => row.transactionRef === "YFX-STR-1");
    const seen = admin.transactions.find((row: { transactionRef: string }) => row.transactionRef === "YFX-STR-1");
    expect(JSON.stringify(supervisor)).not.toContain('"strTag"');
    expect(JSON.stringify(supervisor)).not.toContain('"strLink"');
    expect(sup.structuring).toBe(true);
    expect(sup.structuringTotal).toBe("12000.00");
    expect(sup.purpose).toBe("Travel money");
    expect(seen.strTag).toBe("STR");
    expect(seen.strLink).toBe(sealed.json().filingId);
    expect(seen.structuring).toBe(true);
  });

  it("serves the watch list to supervisor and up, and refuses a teller", async () => {
    for (const role of ["teller", "auditor"] as const) {
      const refused = await app.inject({ method: "GET", url: "/api/ledger/structuring-watch", cookies: await asRole(role) });
      expect(refused.statusCode, role).toBe(403);
      expect(refused.body.toLowerCase()).not.toContain("str");
      expect(refused.body.toLowerCase()).not.toContain("structur");
      expect(refused.body.toLowerCase()).not.toContain("suspicious");
    }
    for (const role of WATCH) {
      const opened = await app.inject({ method: "GET", url: "/api/ledger/structuring-watch", cookies: await asRole(role) });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.json().items).toEqual([
        expect.objectContaining({ customerId: "cust-watch", name: "Nora Quinn", count: 2, total: "12000.00", acknowledged: false }),
      ]);
    }
  });

  it("refuses a teller acknowledge before any write", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("teller"),
      payload: { customerId: "cust-watch" },
    });
    expect(refused.statusCode).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks")).rows[0].n).toBe(0);
    const saved = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("supervisor"),
      payload: { customerId: "cust-watch" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks")).rows[0].n).toBe(1);
    const again = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("teller"),
      payload: { customerId: "cust-watch" },
    });
    expect(again.statusCode).toBe(403);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks")).rows[0].n).toBe(1);
  });
});
