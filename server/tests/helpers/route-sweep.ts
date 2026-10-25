/* Shared pieces for a GET route sweep.
   listGetRoutes reads the registered GET tree off the Fastify app.
   seedSweepFixture opens a client, two cash deals, and a sealed STR.
   fillRoute puts those fixture ids into every :param. */
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { hashPassword } from "../../src/auth/password.js";
import { schema, type Db } from "../../src/db/index.js";
import { DEMO } from "../../src/seed.js";

export const SWEEP_CUSTOMER = "Nora Quinn";

export type SweepIds = {
  clientId: string;
  customerId: string;
  quoteId: string;
  filingId: string;
  transactionId: string;
  transactionRef: string;
  slug: string;
  code: string;
  ref: string;
  tenantId: string;
  enquiryId: string;
  staffId: string;
  rateBoardId: string;
  marketSnapshotId: string;
};

type RouteApp = {
  printRoutes(options: { commonPrefix: false; method: "GET" }): string;
};

/* printRoutes nests even with commonPrefix off. A GET leaf is the
   segments joined by depth. HEAD is a different method and stays out. */
export function listGetRoutes(app: RouteApp): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false, method: "GET" }).split("\n")) {
    const match = line.match(/^((?:│   |    )*)[├└]── (.*)$/);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    const methods = match[2]!.match(/ \(([^)]*)\)$/);
    if (!methods || !methods[1]!.split(", ").includes("GET")) continue;
    const segment = match[2]!.slice(0, match[2]!.length - methods[0].length);
    stack.length = depth;
    stack[depth] = segment;
    out.push(stack.join(""));
  }
  return out;
}

/* :id is the tenant, except on the enquiry and staff doors.
   A staff id contains a colon, so every value is percent-encoded.
   An unknown param throws. A leftover colon throws. */
export function fillRoute(route: string, ids: SweepIds): string {
  const params = new Map<string, string>([
    ["slug", ids.slug],
    ["code", ids.code],
    ["ref", ids.ref],
    ["clientId", ids.clientId],
    ["transactionId", ids.transactionId],
    ["quoteId", ids.quoteId],
    ["filingId", ids.filingId],
    ["id", ids.tenantId],
  ]);
  if (route.startsWith("/api/admin/enquiries/")) params.set("id", ids.enquiryId);
  else if (route.startsWith("/api/admin/staff/")) params.set("id", ids.staffId);
  let url = route.replace(/:([A-Za-z0-9_]+)/g, (_full, name: string) => {
    const value = params.get(name);
    if (!value) throw new Error("no fixture id for :" + name);
    return encodeURIComponent(value);
  });
  if (route === "/api/clients/lookup") url += "?name=" + encodeURIComponent(SWEEP_CUSTOMER);
  url = url.replaceAll("*", "");
  if (url.includes(":")) throw new Error("unfilled param in " + url);
  return url;
}

async function session(app: FastifyInstance, staffId: string, tenantId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId },
  });
  if (login.statusCode !== 200) throw new Error("login " + staffId + " " + login.statusCode + " " + login.body);
  const value = login.cookies.find((item) => item.name === "cdos_session")?.value;
  if (!value) throw new Error("login " + staffId + " set no session");
  return { cdos_session: value };
}

function expectStatus(res: { statusCode: number; body: string }, status: number, what: string): void {
  if (res.statusCode !== status) throw new Error(what + " expected " + status + ", got " + res.statusCode + " " + res.body);
}

/* A new tenant id on every run, so a sealed filing left behind cannot
   land on a tenant another test counts. */
export async function seedSweepFixture(app: FastifyInstance, pool: pg.Pool, db: Db): Promise<SweepIds> {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const tenantId = "tnt-sweep-" + suffix;
  const legalEntityId = "le-sweep-" + suffix;
  const branchId = "br-sweep-" + suffix;
  const workspaceId = "ws-sweep-" + suffix;
  const rateBoardId = "board-" + suffix;
  const marketSnapshotId = "snap-" + suffix;
  const passwordHash = await hashPassword(DEMO.password);
  await db.insert(schema.tenants).values({ id: tenantId, name: "Sweep" });
  await db.insert(schema.legalEntities).values({
    id: legalEntityId,
    tenantId,
    name: "Sweep",
    jurisdiction: "FINTRAC",
    homeCurrency: "CAD",
    jurisdictionPackId: "pack-ca-v1",
    jurisdictionPackVersion: 1,
  });
  await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Sweep" });
  await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" });
  for (const [staffId, name, role] of [
    ["m.costa", "M. Costa", "teller"],
    ["j.masri", "J. Masri", "administrator"],
  ] as const) {
    await db.insert(schema.staffUsers).values({
      id: tenantId + ":" + staffId,
      tenantId,
      legalEntityId,
      branchId,
      staffId,
      name,
      role,
      authorizedBranchIds: [branchId],
      passwordHash,
    });
  }
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'Sweep')", [tenantId]);
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'Sweep', 'FINTRAC', 'CAD', 'pack-ca-v1', 1)`,
    [legalEntityId, tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Sweep')",
    [branchId, tenantId, legalEntityId],
  );
  await pool.query(
    "INSERT INTO market_rates (id, provider, mids, fetched_at) VALUES ($1, 'test', '{\"USD\":1.4}', now())",
    [marketSnapshotId],
  );
  await pool.query(
    `INSERT INTO rate_boards (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, market_snapshot_id, published_by, published_at)
     VALUES ($1, $2, $3, $4, 0.02, 0.03, '{"USD":{"mid":1.4,"show":true}}', $5, 'seed', now())`,
    [rateBoardId, tenantId, legalEntityId, branchId, marketSnapshotId],
  );
  const teller = await session(app, "m.costa", tenantId);
  const owner = await session(app, "j.masri", tenantId);
  const created = await app.inject({
    method: "POST",
    url: "/api/clients",
    cookies: teller,
    payload: { legalName: SWEEP_CUSTOMER, kind: "individual" },
  });
  expectStatus(created, 201, "client");
  const clientId = String(created.json().clientId ?? "");
  if (!clientId) throw new Error("client create returned no clientId");
  const customer = await pool.query("SELECT customer_id FROM ledger_customers WHERE client_id = $1", [clientId]);
  const customerId = String(customer.rows[0]?.customer_id ?? "");
  if (!customerId) throw new Error("client " + clientId + " has no ledger customer");

  const mark = Date.now().toString(36);
  const transactionId = "tx-sweep-" + mark;
  const transactionRef = "YFX-SWEEP-" + mark;
  const otherId = "tx-sweep-b-" + mark;
  const otherRef = "YFX-SWEEP-B-" + mark;
  const scope = [tenantId, legalEntityId, branchId, workspaceId, "till-01"];
  for (const [tx, ref] of [[transactionId, transactionRef], [otherId, otherRef]] as const) {
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, customer_id, actor_id,
          from_currency, to_currency, input_amount, output_amount, rate, fee_cad, spread_cad, purpose, source_of_funds, posted_at,
          deal_kind, received_instrument, disbursed_instrument, cash_in_home)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CAD', 'USD', 6000, 4400, 0.73, 0, 0, 'Travel money', 'Employment income', now(),
               'exchange', 'cash', 'cash', 6000)`,
      [tx, ref, ...scope, customerId, tenantId + ":j.masri"],
    );
  }

  const quote = await app.inject({
    method: "POST",
    url: "/api/quotes",
    cookies: teller,
    payload: {
      customerId,
      from: "CAD",
      to: "USD",
      inputAmount: "100.00",
      feeCad: "0.00",
      direction: "customer_buy_foreign",
    },
  });
  expectStatus(quote, 201, "quote");
  const quoteId = String(quote.json().quoteId ?? "");
  if (!quoteId) throw new Error("quote create returned no quoteId");

  const filing = await app.inject({
    method: "POST",
    url: "/api/ledger/report-filings",
    cookies: owner,
    payload: {
      reportCode: "STR",
      obligationId: "STR-SWEEP-" + mark,
      obligationGroupId: "STR-SWEEP",
      reportRef: "REF-SWEEP-" + mark,
      subjectName: SWEEP_CUSTOMER,
      reportedAmount: "6000.00",
      reportedCurrency: "CAD",
      transactionRefs: [transactionRef, otherRef],
      aggregationBasis: "conductor",
      windowStart: "2026-10-20T00:00:00-04:00",
      windowEnd: "2026-10-21T00:00:00-04:00",
      acknowledgementRef: "ACK-SWEEP-" + mark,
      payload: { basis: "structuring", reportId: "STR-SWEEP-" + mark, kind: "STR" },
      amendsFilingId: null,
    },
  });
  expectStatus(filing, 201, "filing");
  const filingId = String(filing.json().filingId ?? "");
  if (!filingId) throw new Error("filing create returned no filingId");

  return {
    clientId,
    customerId,
    quoteId,
    filingId,
    transactionId,
    transactionRef,
    slug: "yorkfx",
    code: "yorkfx",
    ref: "CD-WALKTHRU",
    tenantId,
    enquiryId: "enq-walkthrough",
    staffId: tenantId + ":m.costa",
    rateBoardId,
    marketSnapshotId,
  };
}
