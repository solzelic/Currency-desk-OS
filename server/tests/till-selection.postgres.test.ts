/* ============================================================
   Naming which drawer the ledger is answering for.

   The browser's till switcher used to change a label and nothing else: the
   workspace header on every subsequent request still named the drawer the
   teller had just left, so a count taken at the second till was written
   against the first. tests/e2e/till-switch-seam.spec.ts is what proves the
   screen and the book now agree; this is the server half — that the roster
   tells the truth about who is on each drawer, that selecting a till is
   authorized and recorded, and that a count follows the named workspace.
   ============================================================ */
import pg from "pg";
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

const SECOND_WORKSPACE = "ws-yorkville-till-02";
const SECOND_TILL = "till-02";
const FOREIGN_BRANCH = "br-elsewhere";
const FOREIGN_WORKSPACE = "ws-elsewhere-till-01";

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

const scopeOf = (workspaceId: string, tillId: string) => [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  workspaceId,
  tillId,
];

async function resetLedger() {
  await pool.query(
    "TRUNCATE ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_till_balances,ledger_principals CASCADE",
  );
  for (const [workspaceId, tillId, cad] of [
    [DEMO.workspaceId, "till-01", "27000.00"],
    [SECOND_WORKSPACE, SECOND_TILL, "9000.00"],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]')`,
      scopeOf(workspaceId, tillId),
    );
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'CAD',$6)",
      [...scopeOf(workspaceId, tillId), cad],
    );
  }
}

postgres("naming a till, against real PostgreSQL", () => {
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
    /* A second drawer at the desk, and one at a branch this teller is not
       posted at. The defect needs the first to exist at all; the second is
       what proves the list is scoped rather than filtered on screen. */
    await handle.db.insert(schema.workspaces).values({
      id: SECOND_WORKSPACE,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      tillId: SECOND_TILL,
    }).onConflictDoNothing();
    await handle.db.insert(schema.branches).values({
      id: FOREIGN_BRANCH,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      name: "Elsewhere Desk",
    }).onConflictDoNothing();
    await handle.db.insert(schema.workspaces).values({
      id: FOREIGN_WORKSPACE,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: FOREIGN_BRANCH,
      tillId: "till-01",
    }).onConflictDoNothing();
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(resetLedger);

  it("reports occupancy from sessions, and says nothing about a till that has none", async () => {
    const cookies = await cookie();
    await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies,
      headers: { "x-workspace-id": DEMO.workspaceId },
    });

    const roster = await app.inject({
      method: "GET",
      url: "/api/ledger/till-roster",
      cookies,
    });
    expect(roster.statusCode).toBe(200);
    const rows = roster.json().workspaces as {
      tillId: string;
      session: { status: string; openedBy: string } | null;
    }[];
    expect(rows.map((row) => row.tillId)).toEqual(["till-01", SECOND_TILL]);
    expect(rows[0]!.session).toMatchObject({
      status: "open",
      openedBy: `${DEMO.tenantId}:a.singh`,
    });
    /* The whole point. The drawer nobody has opened reports NOTHING, so the
       screen has nothing to render — it used to fill this in from a roster
       compiled into the browser and announce an operator who was not there. */
    expect(rows[1]!.session).toBeNull();
    // and a branch this session is not posted at is not in the answer at all
    expect(roster.json().workspaces).toHaveLength(2);
  });

  it("records who moved to which drawer, and answers for that drawer", async () => {
    const cookies = await cookie();
    const selected = await app.inject({
      method: "POST",
      url: "/api/ledger/till-selection",
      cookies,
      headers: { "x-workspace-id": SECOND_WORKSPACE },
      payload: {},
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      workspaceId: SECOND_WORKSPACE,
      tillId: SECOND_TILL,
      // the new till's money arrives with its name, so the screen cannot
      // render one drawer's balance under the other drawer's title
      balances: { CAD: "9000.00" },
      session: null,
    });

    /* The confirmation modal promises the switch is stamped to the audit
       trail with your name and the time. It said so while writing nothing. */
    const audit = await pool.query(
      "SELECT actor_id,workspace_id,reason FROM ledger_audit_events WHERE action='till.select'",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(`${DEMO.tenantId}:a.singh`);
    expect(audit.rows[0].workspace_id).toBe(SECOND_WORKSPACE);
  });

  it("refuses to move a session to a drawer outside its branch", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/api/ledger/till-selection",
      cookies: await cookie(),
      headers: { "x-workspace-id": FOREIGN_WORKSPACE },
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "SCOPE_DENIED" });
    expect(
      (await pool.query("SELECT 1 FROM ledger_audit_events WHERE action='till.select'"))
        .rowCount,
    ).toBe(0);
  });

  /* The server half of the reported defect. The browser's mistake was to keep
     sending the OLD workspace after a switch; what this pins down is that the
     workspace it sends is the only thing deciding where a count lands, so a
     client that names the drawer it is showing cannot write to another one. */
  it("writes a count to the named drawer and leaves the other one alone", async () => {
    const cookies = await cookie();
    for (const workspaceId of [DEMO.workspaceId, SECOND_WORKSPACE]) {
      await app.inject({
        method: "POST",
        url: "/api/ledger/till-sessions/open",
        cookies,
        headers: { "x-workspace-id": workspaceId },
      });
    }
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies,
      headers: { "x-workspace-id": SECOND_WORKSPACE },
      payload: { idempotencyKey: "count-on-two", counts: { CAD: "12345.00" } },
    });
    expect(counted.statusCode).toBe(201);

    const rows = await pool.query(
      `SELECT b.till_id,b.actor_id,c.expected_amount,c.counted_amount
         FROM ledger_till_count_batches b
         JOIN ledger_till_counts c ON c.batch_id=b.batch_id`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].till_id.trim()).toBe(SECOND_TILL);
    expect(rows.rows[0].actor_id).toBe(`${DEMO.tenantId}:a.singh`);
    // against the SECOND drawer's expected figure — the reported defect wrote
    // this count against till-01's 27000.00 and invented a 14,655 variance
    expect(rows.rows[0].expected_amount).toBe("9000.00");
    expect(rows.rows[0].counted_amount).toBe("12345.00");
  });
});
