/* A3.3. A teller reads every registered GET. The route list, the
   fixture, and the :param filler live in helpers/route-sweep.ts.
   This file uploads the client photograph and plants the desk
   snapshot. Two rules apply at every depth: a string that starts
   with STR-, and a key in STR_KEYS or WATCH_KEYS. suspiciousCodes(),
   a "CODE ·" title, and basis structuring are checked only on a
   submission, a history row, a filing, a deal, or an acknowledgement.
   Currency code fields stay out of that check.
   GET /api/ledger/jurisdiction reports[] is the pack catalogue of
   report types, with no subject and no filing. Its keys are allowlisted.
   The owner read of the fixture must show a marked row.
   200 or 403 is the teller's expected status. Any other status is
   named below. */
import pg from "pg";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, provisionPostgres, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { suspiciousCodes } from "../src/state/str-snapshot.js";
import { fillRoute, listGetRoutes, seedSweepFixture, type SweepIds } from "./helpers/route-sweep.js";

const keys = createRequire(import.meta.url)("../../shared/str-role.js") as {
  STR_KEYS: readonly string[];
  WATCH_KEYS: readonly string[];
};
const DOT = " \u00b7";
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FORBIDDEN = new Set<string>([...keys.STR_KEYS, ...keys.WATCH_KEYS]);
/* Keys the catalogue entry actually returns. A new key fails the sweep. */
const CATALOGUE = new Set([
  "code", "name", "kind", "triggerThreshold", "triggerCurrency",
  "aggregationHours", "filingFormat", "deadlineValue", "deadlineUnit",
  "windowKind", "windowDays", "comparator", "direction", "thresholdCurrency",
  "cashOnly", "aggregateAllAmounts", "aggregationAxes", "fields", "formatRules",
]);
const EXPECTED: Record<string, { status: number; reason: string }> = {
  "/api/site/rates": { status: 404, reason: "The host is not a customer domain, so this door has no site." },
  "/api/site/config": { status: 404, reason: "The host is not a customer domain, so this door has no site." },
  "/api/onboarding/:ref/places/details": { status: 400, reason: "Address details need a provider place id, and this call has none." },
};
type Hit = { route: string; field: string; sample: string };

let handle: DbHandle;
let app: FastifyInstance;
let pool: pg.Pool | undefined;
const ledgerUrl = process.env.TEST_DATABASE_URL;

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
    if (FORBIDDEN.has(name)) hits.push({ route, field, sample: "present" });
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
function bundle() {
  return {
    rows: [{
      id: "t1",
      customer: "Nora Quinn",
      note: "travel",
      ackStr: true,
      ackStrInfo: { by: "reviewed by J. Masri", at: "2026-10-25 15:00" },
    }],
    subs: {
      "STR-Nora Quinn-AB12": {
        status: "submitted",
        kind: "SMR",
        prompts: { reason: "pattern kept under the line" },
        sealed: { reportId: "STR-Nora Quinn-AB12", kind: "SMR", basis: "structuring" },
      },
      "STR-Nora Quinn-NOKIND": {
        status: "submitted",
        prompts: { reason: "no kind on the saved entry" },
        sealed: { basis: "structuring" },
      },
      "STR-Nora Quinn-PREP": {
        status: "prepared",
        kind: "STR",
        prompts: { reason: "prepared worksheet" },
        sealed: { kind: "STR", basis: "structuring" },
      },
      "L-LT1": {
        status: "submitted",
        kind: "LCTR",
        ackNo: "A1",
        sealed: { kind: "LCTR", basis: "customer" },
      },
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
  app = await buildApp(handle.db);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  await pool?.end();
  delete process.env.LEDGER_DATABASE_URL;
});

async function session(staffId: string, tenantId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

describe("teller GET route sweep", () => {
  it("keeps a suspicious report off every 2xx JSON body", async () => {
    const ids: SweepIds = await seedSweepFixture(app, pool!, handle.db);
    const teller = await session("m.costa", ids.tenantId);
    const photo = await app.inject({
      method: "PUT",
      url: "/api/clients/" + ids.clientId + "/photograph",
      cookies: teller,
      payload: { dataUrl: PHOTO },
    });
    expect(photo.statusCode, photo.body).toBe(200);
    const owner = await session("j.masri", ids.tenantId);
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/transactions?limit=200",
      cookies: owner,
    });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json().transactions as Array<Record<string, unknown>>;
    const marked = rows.some((row) => row.strTag === "STR" && row.structuring === true);
    expect(marked).toBe(true);
    const opened = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: owner });
    expect(opened.statusCode, opened.body).toBe(200);
    const book = bundle();
    const prior = opened.json().state;
    const state = {
      ...(prior && typeof prior === "object" ? prior as Record<string, unknown> : {}),
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

    const routes = listGetRoutes(app);
    expect(routes).toContain("/api/ledger/transactions/:transactionId/receipt");
    const hits: Hit[] = [];
    const statusErrors: string[] = [];
    let catalogueBody: unknown;
    for (const route of routes) {
      const res = await app.inject({ method: "GET", url: fillRoute(route, ids), cookies: teller });
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
    for (const hit of hits) console.log("LEAK " + hit.route + " " + hit.field);
    expect(statusErrors, statusErrors.join("\n")).toEqual([]);
    expect(shape, shape.join("\n")).toEqual([]);
    expect(hits).toEqual([]);
  }, 60_000);
});
