/* Shared pieces for a GET route sweep.
   listGetRoutes reads the registered GET tree off the Fastify app.
   seedSweepFixture opens a client, two cash deals, and a sealed STR.
   fillRoute puts those fixture ids into every :param. */
import type { FastifyInstance } from "fastify";
import type pg from "pg";
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

async function session(app: FastifyInstance, staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  if (login.statusCode !== 200) throw new Error("login " + staffId + " " + login.statusCode + " " + login.body);
  const value = login.cookies.find((item) => item.name === "cdos_session")?.value;
  if (!value) throw new Error("login " + staffId + " set no session");
  return { cdos_session: value };
}

function expectStatus(res: { statusCode: number; body: string }, status: number, what: string): void {
  if (res.statusCode !== status) throw new Error(what + " expected " + status + ", got " + res.statusCode + " " + res.body);
}

/* The caller has already provisioned the ledger and published a rate
   board. This opens the client, the two deals, the quote, and the STR. */
export async function seedSweepFixture(app: FastifyInstance, pool: pg.Pool): Promise<SweepIds> {
  const teller = await session(app, "m.costa");
  const owner = await session(app, "j.masri");
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
  const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
  for (const [tx, ref] of [[transactionId, transactionRef], [otherId, otherRef]] as const) {
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, customer_id, actor_id,
          from_currency, to_currency, input_amount, output_amount, rate, fee_cad, spread_cad, purpose, source_of_funds, posted_at,
          deal_kind, received_instrument, disbursed_instrument, cash_in_home)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CAD', 'USD', 6000, 4400, 0.73, 0, 0, 'Travel money', 'Employment income', now(),
               'exchange', 'cash', 'cash', 6000)`,
      [tx, ref, ...scope, customerId, DEMO.tenantId + ":j.masri"],
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
    tenantId: DEMO.tenantId,
    enquiryId: "enq-walkthrough",
    staffId: DEMO.tenantId + ":m.costa",
  };
}
