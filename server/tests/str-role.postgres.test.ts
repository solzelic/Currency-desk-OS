/* Who may file, and who may read an STR on a deal.
   A teller, an auditor, and a supervisor may not file. A supervisor
   may read an LCTR. The three compliance roles may file and read.
   A deal keeps its plain fields and drops the STR fields a role
   may not see. The watch query runs only for the watch roles.
   The watch list and acknowledge stop at supervisor. */
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
  presentDeal: (role: string, deal: Record<string, unknown>) => Record<string, unknown>;
  STR_KEYS: readonly string[];
  WATCH_KEYS: readonly string[];
};
const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const STR = ["administrator", "branch_manager", "compliance_officer"];
const WATCH = [...STR, "supervisor"];
const HIDDEN = [...roles.STR_KEYS, ...roles.WATCH_KEYS];

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
    expect(roles.canReleaseFiling("supervisor", "LCTR")).toBe(false);
    expect(roles.canReleaseFiling("supervisor", "lctr")).toBe(false);
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
    for (const role of STR) expect(hasBackendPermission(role, "compliance:file"), role).toBe(true);
    expect(hasBackendPermission("supervisor", "compliance:file")).toBe(false);
  });

  it("freezes the key lists and strips exactly those keys", () => {
    expect(Object.isFrozen(roles.STR_KEYS)).toBe(true);
    expect(Object.isFrozen(roles.WATCH_KEYS)).toBe(true);
    const deal = () => {
      const row: Record<string, unknown> = { purpose: "Travel money" };
      for (const key of [...roles.STR_KEYS, ...roles.WATCH_KEYS]) row[key] = key;
      return row;
    };
    const teller = roles.presentDeal("teller", deal());
    expect(Object.keys(teller).sort()).toEqual(["purpose"]);
    const supervisor = roles.presentDeal("supervisor", deal());
    expect(Object.keys(supervisor).sort()).toEqual([...roles.WATCH_KEYS, "purpose"].sort());
    for (const key of roles.WATCH_KEYS) expect(supervisor[key]).toBe(key);
    const admin = roles.presentDeal("administrator", deal());
    expect(Object.keys(admin).sort()).toEqual([...roles.STR_KEYS, ...roles.WATCH_KEYS, "purpose"].sort());
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

function isWatchQuery(sql: string) {
  return /make_interval\s*\(\s*days/i.test(sql) || /ledger_structuring_acks/i.test(sql);
}

async function captureSql(run: () => Promise<void>) {
  const seen: string[] = [];
  const proto = pg.Client.prototype as unknown as {
    query: (...args: unknown[]) => unknown;
  };
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
    if (typeof text === "string") seen.push(text);
    return original.apply(this, args);
  };
  try {
    await run();
  } finally {
    proto.query = original;
  }
  return seen;
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function clearBook() {
  await pool.query(
    "ALTER TABLE ledger_structuring_acks DISABLE TRIGGER ledger_structuring_acks_no_truncate",
  );
  await pool.query(
    `TRUNCATE ledger_structuring_acks, ledger_filing_flags,
            ledger_report_filings, ledger_audit_events, ledger_transactions,
            ledger_customers, ledger_principals CASCADE`,
  );
  await pool.query(
    "ALTER TABLE ledger_structuring_acks ENABLE TRIGGER ledger_structuring_acks_no_truncate",
  );
}

async function addCustomer(id: string, name: string) {
  await pool.query(
    `INSERT INTO ledger_customers (
       customer_id, tenant_id, legal_entity_id, branch_id, workspace_id,
       name, risk, id_status
     ) VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified')`,
    [id, ...scope.slice(0, 4), name],
  );
}

async function postCash(
  id: string,
  ref: string,
  customerId: string,
  amount: string,
  postedAt: Date,
) {
  await pool.query(
    `INSERT INTO ledger_transactions (
       transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
       workspace_id, till_id, customer_id, actor_id,
       from_currency, to_currency, input_amount, output_amount, rate,
       fee_cad, spread_cad, purpose, source_of_funds, posted_at,
       deal_kind, received_instrument, disbursed_instrument, cash_in_home
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $3 || ':j.masri',
       'CAD', 'USD', $9, 4400, 0.73, 0, 0,
       'Travel money', 'Employment income', $10,
       'exchange', 'cash', 'cash', $9
     )`,
    [id, ref, ...scope, customerId, amount, postedAt],
  );
}

async function acknowledge(customerId: string, staffId?: string) {
  const cookies = staffId ? await cookie(staffId) : await asRole("supervisor");
  return app.inject({
    method: "POST",
    url: "/api/ledger/structuring-watch/acknowledge",
    cookies,
    payload: { customerId },
  });
}

async function watchItem(customerId: string) {
  const list = await app.inject({
    method: "GET",
    url: "/api/ledger/structuring-watch",
    cookies: await asRole("supervisor"),
  });
  expect(list.statusCode, list.body).toBe(200);
  return list.json().items.find(
    (row: { customerId: string }) => row.customerId === customerId,
  );
}

async function dealRows(customerId: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/ledger/transactions",
    cookies: await asRole("supervisor"),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().transactions.filter(
    (row: { customerId: string }) => row.customerId === customerId,
  );
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

postgres("str filing and the transaction field strip", () => {
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
    await clearBook();
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await clearBook();
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
      expect(postLctr.statusCode, role).toBe(strOk ? 201 : 403);
      expect(postStr.statusCode, role).toBe(strOk ? 201 : 403);
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
      const refused = await app.inject({
        method: "GET",
        url: "/api/ledger/structuring-watch",
        cookies: await asRole(role),
      });
      expect(refused.statusCode, role).toBe(403);
      expect(refused.body.toLowerCase()).not.toContain("str");
      expect(refused.body.toLowerCase()).not.toContain("structur");
      expect(refused.body.toLowerCase()).not.toContain("suspicious");
    }
    for (const role of WATCH) {
      const opened = await app.inject({
        method: "GET",
        url: "/api/ledger/structuring-watch",
        cookies: await asRole(role),
      });
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.json().items).toEqual([
        expect.objectContaining({
          customerId: "cust-watch",
          name: "Nora Quinn",
          count: 2,
          total: "12000.00",
          acknowledged: false,
        }),
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
    const none = await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks");
    expect(none.rows[0].n).toBe(0);
    const saved = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("supervisor"),
      payload: { customerId: "cust-watch" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const once = await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks");
    expect(once.rows[0].n).toBe(1);
    const again = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("teller"),
      payload: { customerId: "cust-watch" },
    });
    expect(again.statusCode).toBe(403);
    const still = await pool.query("SELECT count(*)::int AS n FROM ledger_structuring_acks");
    expect(still.rows[0].n).toBe(1);
  });

  it("a second acknowledge of the same customer adds a row and the read shows the newest", async () => {
    const newestId = `${DEMO.tenantId}:j.masri`;
    const first = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("supervisor"),
      payload: { customerId: "cust-watch" },
    });
    expect(first.statusCode, first.body).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await cookie("j.masri"),
      payload: { customerId: "cust-watch" },
    });
    expect(second.statusCode, second.body).toBe(200);
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_structuring_acks WHERE customer_id = $1",
      ["cust-watch"],
    );
    expect(rows.rows[0].n).toBe(2);
    const list = await app.inject({
      method: "GET",
      url: "/api/ledger/structuring-watch",
      cookies: await asRole("supervisor"),
    });
    expect(list.statusCode, list.body).toBe(200);
    const item = list.json().items.find(
      (row: { customerId: string }) => row.customerId === "cust-watch",
    );
    expect(item.count).toBe(2);
    expect(item.total).toBe("12000.00");
    expect(item.actorId).toBe(newestId);
    expect(item.acknowledged).toBe(true);
    const deals = await app.inject({
      method: "GET",
      url: "/api/ledger/transactions",
      cookies: await asRole("supervisor"),
    });
    expect(deals.statusCode, deals.body).toBe(200);
    const deal = deals.json().transactions.find(
      (row: { transactionRef: string }) => row.transactionRef === "YFX-STR-1",
    );
    expect(deal.ackStr).toBe(true);
    expect(deal.ackStrInfo.by).toBe(newestId);
  });

  it("refuses an update or a delete of a structuring acknowledgement", async () => {
    const saved = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("supervisor"),
      payload: { customerId: "cust-watch" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await expect(
      pool.query("UPDATE ledger_structuring_acks SET actor_id = actor_id"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM ledger_structuring_acks"),
    ).rejects.toThrow(/append-only/);
    const kept = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_structuring_acks",
    );
    expect(kept.rows[0].n).toBe(1);
  });

  it("runs no watch query for a teller or an auditor, and returns no watch keys", async () => {
    for (const role of ["teller", "auditor"] as const) {
      const seen = await captureSql(async () => {
        const res = await app.inject({
          method: "GET",
          url: "/api/ledger/transactions",
          cookies: await asRole(role),
        });
        expect(res.statusCode, role).toBe(200);
        for (const key of roles.WATCH_KEYS) {
          expect(res.body, `${role} ${key}`).not.toContain(`"${key}"`);
        }
        expect(res.body, role).toContain("Travel money");
      });
      expect(seen.filter(isWatchQuery), role).toEqual([]);
    }
  });

  it("shows a supervisor the watch and none of the STR keys", async () => {
    const seen = await captureSql(async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/ledger/transactions",
        cookies: await asRole("supervisor"),
      });
      expect(res.statusCode, res.body).toBe(200);
      const row = res.json().transactions.find(
        (item: { transactionRef: string }) => item.transactionRef === "YFX-STR-1",
      );
      expect(row.structuring).toBe(true);
      expect(row.structuringTotal).toBe("12000.00");
      expect(row.ackStr).toBe(false);
      for (const key of roles.WATCH_KEYS) expect(row, key).toHaveProperty(key);
      for (const key of roles.STR_KEYS) {
        expect(row, key).not.toHaveProperty(key);
        expect(res.body, key).not.toContain(`"${key}"`);
      }
    });
    expect(seen.some(isWatchQuery)).toBe(true);
  });

  it("a third qualifying deal of 9000 leaves 21000 unacknowledged", async () => {
    const saved = await acknowledge("cust-watch");
    expect(saved.statusCode, saved.body).toBe(200);
    const before = await watchItem("cust-watch");
    expect(before.count).toBe(2);
    expect(before.total).toBe("12000.00");
    expect(before.acknowledged).toBe(true);
    await postCash("tx-str-3", "YFX-STR-3", "cust-watch", "9000.00", new Date());
    const item = await watchItem("cust-watch");
    expect(item.count).toBe(3);
    expect(item.total).toBe("21000.00");
    expect(item.acknowledged).toBe(false);
    const rows = await dealRows("cust-watch");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.ackStr).toBe(false);
      expect(row.structuring).toBe(true);
      expect(row.structuringTotal).toBe("21000.00");
    }
  });

  it("a return to the watch after leaving it is unacknowledged", async () => {
    await addCustomer("cust-return", "Rita Stone");
    await postCash("tx-ret-1", "YFX-RET-1", "cust-return", "6000.00", daysAgo(6));
    await postCash("tx-ret-2", "YFX-RET-2", "cust-return", "6000.00", daysAgo(6));
    const saved = await acknowledge("cust-return");
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await watchItem("cust-return")).acknowledged).toBe(true);
    await pool.query(
      `INSERT INTO ledger_reversals
         (reversal_id, transaction_id, actor_id, reason, posted_at)
       VALUES ('rev-ret-1','tx-ret-1',$1,'aged out',now()),
              ('rev-ret-2','tx-ret-2',$1,'aged out',now())`,
      [`${DEMO.tenantId}:j.masri`],
    );
    expect(await watchItem("cust-return")).toBeUndefined();
    await postCash("tx-ret-3", "YFX-RET-3", "cust-return", "6000.00", daysAgo(3));
    await postCash("tx-ret-4", "YFX-RET-4", "cust-return", "6000.00", daysAgo(3));
    const item = await watchItem("cust-return");
    expect(item.count).toBe(2);
    expect(item.total).toBe("12000.00");
    expect(item.acknowledged).toBe(false);
    const rows = await dealRows("cust-return");
    const refs = rows.map((row: { transactionRef: string }) => row.transactionRef);
    expect(refs.sort()).toEqual(["YFX-RET-1", "YFX-RET-2", "YFX-RET-3", "YFX-RET-4"]);
    for (const row of rows) expect(row.ackStr).toBe(false);
  });

  it("refuses an acknowledgement for ghost-nobody", async () => {
    const refused = await acknowledge("ghost-nobody");
    expect(refused.statusCode).toBe(404);
    expect(refused.json().message).toBe("This customer is not on the watch.");
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_structuring_acks",
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses an acknowledgement for a real customer who is not on the watch", async () => {
    await addCustomer("cust-quiet", "Sam Quiet");
    const refused = await acknowledge("cust-quiet");
    expect(refused.statusCode).toBe(404);
    expect(refused.json().message).toBe("This customer is not on the watch.");
    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_structuring_acks",
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("stores the actor role from the session", async () => {
    const saved = await acknowledge("cust-watch");
    expect(saved.statusCode, saved.body).toBe(200);
    const spoiled = await app.inject({
      method: "POST",
      url: "/api/ledger/structuring-watch/acknowledge",
      cookies: await asRole("supervisor"),
      payload: { customerId: "cust-watch", role: "administrator" },
    });
    expect(spoiled.statusCode).toBe(400);
    const admin = await acknowledge("cust-watch", "j.masri");
    expect(admin.statusCode, admin.body).toBe(200);
    const roles = await pool.query(
      "SELECT actor_role FROM ledger_structuring_acks ORDER BY ack_id",
    );
    expect(roles.rows.map((row) => row.actor_role)).toEqual([
      "supervisor",
      "administrator",
    ]);
  });

  it("refuses a truncate of a structuring acknowledgement", async () => {
    const saved = await acknowledge("cust-watch");
    expect(saved.statusCode, saved.body).toBe(200);
    await expect(
      pool.query("TRUNCATE ledger_structuring_acks"),
    ).rejects.toThrow(/append-only/);
    const kept = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_structuring_acks",
    );
    expect(kept.rows[0].n).toBe(1);
  });

  it("keeps ackStr false for every role", async () => {
    for (const role of ["teller", "auditor", ...WATCH]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/ledger/transactions",
        cookies: await asRole(role),
      });
      expect(res.statusCode, role).toBe(200);
      expect(res.body, role).not.toContain('"ackStr":true');
      const row = res.json().transactions.find(
        (item: { transactionRef: string }) => item.transactionRef === "YFX-STR-1",
      );
      if (roles.canSeeStructuringWatch(role)) {
        expect(row.ackStr, role).toBe(false);
        expect(row.ackStrInfo, role).toBe(null);
      } else {
        expect(row, role).not.toHaveProperty("ackStr");
        expect(row, role).not.toHaveProperty("ackStrInfo");
      }
    }
  });
});
