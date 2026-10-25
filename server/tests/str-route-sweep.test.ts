/* A3.3. A teller reads every registered GET. Two rules apply at every
   depth: a string that starts with STR-, and a key named ackStr,
   ackStrInfo, strStatus, structuring, or structuringWatch.
   suspiciousCodes(), a "CODE ·" title, and basis structuring are
   checked only on a submission, a history row, a filing, a deal, or
   an acknowledgement. Currency code fields stay out of that check.
   GET /api/ledger/jurisdiction reports[] is the pack catalogue of
   report types, with no subject and no filing. Its keys are allowlisted.
   200 or 403 is the teller's expected status. Any other status is
   named below. The route list comes from the app. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, provisionPostgres, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { suspiciousCodes } from "../src/state/str-snapshot.js";

const DOT = " \u00b7";
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GLOBAL_KEYS = new Set(["ackStr", "ackStrInfo", "strStatus", "structuring", "structuringWatch"]);
/* Keys the catalogue entry actually returns. A new key fails the sweep. */
const CATALOGUE = new Set([
  "code", "name", "kind", "triggerThreshold", "triggerCurrency", "aggregationHours", "filingFormat",
  "deadlineValue", "deadlineUnit", "windowKind", "windowDays", "comparator", "direction",
  "thresholdCurrency", "cashOnly", "aggregateAllAmounts", "aggregationAxes", "fields", "formatRules",
]);
const EXPECTED: Record<string, { status: number; reason: string }> = {
  "/api/site/rates": { status: 404, reason: "The host is not a customer domain, so this door has no site." },
  "/api/site/config": { status: 404, reason: "The host is not a customer domain, so this door has no site." },
  "/api/onboarding/:ref/places/details": { status: 400, reason: "Address details need a provider place id, and this call has none." },
};
type Hit = { route: string; field: string; sample: string };
type Ids = {
  clientId: string;
  customerId: string;
  quoteId: string;
  filingId: string;
  transactionId: string;
  ref: string;
};

let handle: DbHandle;
let app: FastifyInstance;
let pool: pg.Pool | undefined;
const ledgerUrl = process.env.TEST_DATABASE_URL;
const ids: Ids = { clientId: "", customerId: "", quoteId: "", filingId: "", transactionId: "", ref: "" };

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parsed(value: string): unknown | undefined {
  try {
    const out = JSON.parse(value) as unknown;
    return out && typeof out === "object" ? out : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
/* A submission, a history row, a filing, a deal the marks sit on, or an ack. */
function reportShaped(obj: Record<string, unknown>): boolean {
  if ("sealed" in obj || "prompts" in obj || "ticks" in obj || "groupId" in obj || "ackNo" in obj) return true;
  if ("reportCode" in obj || "filingId" in obj || "obligationId" in obj || "acknowledgementRef" in obj) return true;
  if (obj.filing === true || "basis" in obj) return true;
  if (typeof obj.title === "string" && "type" in obj) return true;
  if ("transactionId" in obj || "transactionRef" in obj || "strTag" in obj || "strLink" in obj || "structuringTotal" in obj) return true;
  const names = Object.keys(obj);
  return names.length > 0 && names.every((name) => name === "by" || name === "at");
}
function sampleOf(value: unknown): string {
  if (typeof value !== "string") return "present";
  if (value.startsWith("STR-")) return "STR-";
  const code = [...suspiciousCodes()].find((item) => value.trim().toUpperCase() === item || value.startsWith(item + DOT));
  return code ?? "present";
}
function walk(value: unknown, path: string, hits: Hit[], route: string): void {
  if (typeof value === "string") {
    if (value.startsWith("STR-")) hits.push({ route, field: path || "value", sample: "STR-" });
    const inner = parsed(value);
    if (inner) walk(inner, path, hits, route);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, path + "[" + index + "]", hits, route));
    return;
  }
  if (!plain(value)) return;
  const shaped = reportShaped(value);
  for (const [name, item] of Object.entries(value)) {
    const field = path ? path + "." + name : name;
    if (GLOBAL_KEYS.has(name)) hits.push({ route, field, sample: "present" });
    if (shaped && name === "basis" && item === "structuring") hits.push({ route, field, sample: "structuring" });
    if (shaped && (name === "kind" || name === "type" || name === "code") && typeof item === "string" && suspiciousCodes().has(item.trim().toUpperCase())) {
      hits.push({ route, field, sample: sampleOf(item) });
    }
    if (shaped && name === "title" && typeof item === "string" && [...suspiciousCodes()].some((code) => item.startsWith(code + DOT))) {
      hits.push({ route, field, sample: sampleOf(item) });
    }
    walk(item, field, hits, route);
  }
}
function forbiddenKey(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "id" || name.endsWith("Id") || name.endsWith("_id")) return true;
  return ["client", "customer", "subject", "submission", "date", "count"].some((word) => lower.includes(word));
}
function catalogueKeys(value: unknown, path: string, bad: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => catalogueKeys(item, path + "[" + index + "]", bad));
    return;
  }
  if (!plain(value)) return;
  for (const [name, item] of Object.entries(value)) {
    const field = path ? path + "." + name : name;
    if (!CATALOGUE.has(name) || forbiddenKey(name)) bad.push(field);
    catalogueKeys(item, field, bad);
  }
}
/* Pack catalogue of report types. No subject and no filing. */
function catalogue(body: unknown): string[] {
  const reports = plain(body) && Array.isArray(body.reports) ? body.reports : null;
  if (!reports || reports.length === 0) return ["reports missing"];
  const bad: string[] = [];
  const codes = new Set<string>();
  reports.forEach((entry, index) => {
    if (!plain(entry)) {
      bad.push("reports[" + index + "]");
      return;
    }
    if (typeof entry.code === "string") codes.add(entry.code);
    catalogueKeys(entry, "reports[" + index + "]", bad);
  });
  if (!codes.has("STR")) bad.push("reports missing STR");
  return bad;
}
function getRoutes(tree: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split("\n")) {
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
function fill(route: string): string {
  let url = route;
  if (route.startsWith("/api/admin/tenants/")) url = url.replaceAll(":id", encodeURIComponent(DEMO.tenantId));
  else if (route.startsWith("/api/admin/enquiries/")) url = url.replaceAll(":id", "enq-walkthrough");
  else if (route.startsWith("/api/admin/staff/")) url = url.replaceAll(":id", encodeURIComponent(DEMO.tenantId + ":m.costa"));
  else {
    const params: Record<string, string> = {
      slug: "yorkfx",
      code: "yorkfx",
      ref: "CD-WALKTHRU",
      clientId: ids.clientId,
      transactionId: ids.transactionId,
      quoteId: ids.quoteId,
      filingId: ids.filingId,
      id: DEMO.tenantId,
    };
    url = url.replace(/:([A-Za-z0-9_]+)/g, (_full, name: string) => encodeURIComponent(params[name] ?? "missing-" + name));
  }
  if (route === "/api/clients/lookup") url += "?name=" + encodeURIComponent("Nora Quinn");
  return url.replace(/\*/g, "");
}
function bundle() {
  return {
    rows: [{ id: "t1", customer: "Nora Quinn", note: "travel", ackStr: true, ackStrInfo: { by: "reviewed by J. Masri", at: "2026-10-25 15:00" } }],
    subs: {
      "STR-Nora Quinn-AB12": { status: "submitted", kind: "SMR", prompts: { reason: "pattern kept under the line" }, sealed: { reportId: "STR-Nora Quinn-AB12", kind: "SMR", basis: "structuring" } },
      "STR-Nora Quinn-NOKIND": { status: "submitted", prompts: { reason: "no kind on the saved entry" }, sealed: { basis: "structuring" } },
      "STR-Nora Quinn-PREP": { status: "prepared", kind: "STR", prompts: { reason: "prepared worksheet" }, sealed: { kind: "STR", basis: "structuring" } },
      "L-LT1": { status: "submitted", kind: "LCTR", ackNo: "A1", sealed: { kind: "LCTR", basis: "customer" } },
    },
    hist: [
      { key: "F1", type: "SMR", title: "Suspicious Matter Report" + DOT + " Nora Quinn", filing: true },
      { key: "F3", type: "STR", title: "STR" + DOT + " Nora Quinn", filing: true },
      { key: "F2", type: "LCTR", title: "Large Cash Transaction Report" + DOT + " Nora Quinn", filing: true },
      { key: "K1", type: "KYC", title: "KYC verification" + DOT + " Nora Quinn" },
    ],
  };
}

beforeAll(async () => {
  expect(ledgerUrl, "TEST_DATABASE_URL").toBeTruthy();
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.LEDGER_DATABASE_URL = ledgerUrl;
  handle = await createDb();
  await seed(handle.db);
  pool = await provisionPostgres(ledgerUrl!);
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'York FX', 'FINTRAC', 'CAD', 'pack-ca-v1', 1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id = 'pack-ca-v1', home_currency = 'CAD', jurisdiction_pack_version = 1`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    "INSERT INTO market_rates (id, provider, mids, fetched_at) VALUES ('a33-snap', 'test', '{\"USD\":1.4}', now()) ON CONFLICT (id) DO UPDATE SET fetched_at = now()",
  );
  await pool.query(
    `INSERT INTO rate_boards (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, market_snapshot_id, published_by, published_at)
     VALUES ('a33-board', $1, $2, $3, 0.02, 0.03, '{"USD":{"mid":1.4,"show":true}}', 'a33-snap', 'seed', now())
     ON CONFLICT (id) DO UPDATE SET published_at = now(), board_rows = EXCLUDED.board_rows`,
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
  );
  app = await buildApp(handle.db);
}, 60_000);

afterAll(async () => {
  if (pool) {
    await pool.query("DELETE FROM rate_boards WHERE id = 'a33-board'");
    await pool.query("DELETE FROM market_rates WHERE id = 'a33-snap'");
  }
  await app?.close();
  await handle?.close();
  await pool?.end();
  delete process.env.LEDGER_DATABASE_URL;
});

async function cookies(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

describe("teller GET route sweep", () => {
  it("keeps a suspicious report off every 2xx JSON body", async () => {
    const owner = await cookies("j.masri");
    const teller = await cookies("m.costa");
    const opened = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: owner });
    expect(opened.statusCode, opened.body).toBe(200);
    const book = bundle();
    const state = {
      ...(opened.json().state as Record<string, unknown>),
      cdos_rows_v1: JSON.stringify(book.rows),
      cdos_submissions_v1: JSON.stringify(book.subs),
      cdos_report_history_v1: JSON.stringify(book.hist),
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/tenant/state",
      cookies: owner,
      payload: { state, version: opened.json().version as number },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies: teller,
      payload: { legalName: "Nora Quinn", kind: "individual" },
    });
    expect(created.statusCode, created.body).toBe(201);
    ids.clientId = created.json().clientId as string;
    const photo = await app.inject({
      method: "PUT",
      url: "/api/clients/" + ids.clientId + "/photograph",
      cookies: teller,
      payload: { dataUrl: PHOTO },
    });
    expect(photo.statusCode, photo.body).toBe(200);
    const customer = await pool!.query(
      "SELECT customer_id FROM ledger_customers WHERE client_id = $1",
      [ids.clientId],
    );
    ids.customerId = String(customer.rows[0]?.customer_id ?? "");
    expect(ids.customerId).not.toBe("");
    const mark = Date.now().toString(36);
    ids.transactionId = "tx-a33-" + mark;
    const otherId = "tx-a33-b-" + mark;
    ids.ref = "YFX-A33-" + mark;
    const otherRef = "YFX-A33-B-" + mark;
    const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
    for (const [tx, ref] of [[ids.transactionId, ids.ref], [otherId, otherRef]] as const) {
      await pool!.query(
        `INSERT INTO ledger_transactions
           (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, customer_id, actor_id,
            from_currency, to_currency, input_amount, output_amount, rate, fee_cad, spread_cad, purpose, source_of_funds, posted_at,
            deal_kind, received_instrument, disbursed_instrument, cash_in_home)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CAD', 'USD', 6000, 4400, 0.73, 0, 0, 'Travel money', 'Employment income', now(),
                 'exchange', 'cash', 'cash', 6000)`,
        [tx, ref, ...scope, ids.customerId, DEMO.tenantId + ":j.masri"],
      );
    }
    const quote = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: teller,
      payload: { customerId: ids.customerId, from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "0.00", direction: "customer_buy_foreign" },
    });
    expect(quote.statusCode, quote.body).toBe(201);
    ids.quoteId = quote.json().quoteId as string;
    const filing = await app.inject({
      method: "POST",
      url: "/api/ledger/report-filings",
      cookies: owner,
      payload: {
        reportCode: "STR",
        obligationId: "STR-A33-" + mark,
        obligationGroupId: "STR-A33",
        reportRef: "REF-A33-" + mark,
        subjectName: "Nora Quinn",
        reportedAmount: "6000.00",
        reportedCurrency: "CAD",
        transactionRefs: [ids.ref, otherRef],
        aggregationBasis: "conductor",
        windowStart: "2026-10-20T00:00:00-04:00",
        windowEnd: "2026-10-21T00:00:00-04:00",
        acknowledgementRef: "ACK-A33-" + mark,
        payload: { basis: "structuring", reportId: "STR-A33-" + mark, kind: "STR" },
        amendsFilingId: null,
      },
    });
    expect(filing.statusCode, filing.body).toBe(201);
    ids.filingId = filing.json().filingId as string;
    const seen = await app.inject({ method: "GET", url: "/api/ledger/transactions", cookies: owner });
    expect(seen.statusCode, seen.body).toBe(200);
    const marked = (seen.json().transactions as Array<Record<string, unknown>>).find((row) => row.transactionRef === ids.ref);
    expect(marked?.structuring, seen.body).toBe(true);
    expect(marked?.strTag, seen.body).toBe("STR");

    const routes = getRoutes(app.printRoutes({ commonPrefix: false, method: "GET" }));
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).toContain("/api/tenant/state");
    expect(routes).toContain("/api/clients/:clientId");
    expect(routes).toContain("/api/ledger/transactions/:transactionId/receipt");
    const hits: Hit[] = [];
    const statusErrors: string[] = [];
    let catalogueBody: unknown;
    for (const route of routes) {
      const res = await app.inject({ method: "GET", url: fill(route), cookies: teller });
      console.log(res.statusCode + " " + route);
      const named = EXPECTED[route];
      if (named) {
        if (res.statusCode !== named.status) statusErrors.push(route + " expected " + named.status + " (" + named.reason + ") got " + res.statusCode);
      } else if (res.statusCode !== 200 && res.statusCode !== 403) {
        statusErrors.push(route + " returned " + res.statusCode + ", expected 200 or 403");
      }
      const type = String(res.headers["content-type"] ?? "");
      if (res.statusCode < 200 || res.statusCode >= 300 || !type.includes("json")) continue;
      const body = res.json();
      if (route === "/api/ledger/jurisdiction") catalogueBody = body;
      walk(body, "", hits, route);
    }
    const shape = catalogue(catalogueBody);
    for (const hit of hits) console.log("LEAK " + hit.route + " " + hit.field + " " + hit.sample);
    expect(statusErrors, statusErrors.join("\n")).toEqual([]);
    expect(shape, shape.join("\n")).toEqual([]);
    expect(hits).toEqual([]);
  }, 60_000);
});
