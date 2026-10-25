/* A3.3. A teller reads every registered GET. A 2xx JSON body must not
   carry a suspicious report: an STR- key or id, a structuring basis,
   a kind, type, or code from suspiciousCodes(), a title that starts
   with one of those codes, or ackStr / ackStrInfo.
   403 and 404 pass. The route list comes from the app, not a hand list. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, provisionPostgres, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { suspiciousCodes } from "../src/state/str-snapshot.js";

const DOT = " \u00b7";
const FILL: Record<string, string> = {
  slug: "yorkfx",
  code: "yorkfx",
  ref: "t1",
  id: "t1",
  clientId: "t1",
  filingId: "STR-Nora Quinn-AB12",
  transactionId: "t1",
  quoteId: "t1",
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
function sampleOf(value: unknown): string {
  if (typeof value !== "string") return value === undefined ? "present" : typeof value;
  if (value.startsWith("STR-")) return "STR-";
  const code = [...suspiciousCodes()].find((item) => value === item || value.startsWith(item + DOT));
  return code ?? "present";
}
function walk(value: unknown, path: string, hits: Hit[], route: string, key: string | null): void {
  if (typeof value === "string") {
    if ((key === "id" || key === "key" || key === "reportId") && value.startsWith("STR-")) {
      hits.push({ route, field: path || key, sample: "STR-" });
    }
    const inner = parsed(value);
    if (inner) walk(inner, path, hits, route, null);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, path + "[" + index + "]", hits, route, null));
    return;
  }
  if (!plain(value)) return;
  for (const [name, item] of Object.entries(value)) {
    const field = path ? path + "." + name : name;
    if (name.startsWith("STR-")) hits.push({ route, field, sample: "STR-" });
    if (name === "basis" && item === "structuring") hits.push({ route, field, sample: "structuring" });
    if ((name === "kind" || name === "type" || name === "code") && typeof item === "string" && suspiciousCodes().has(item.trim().toUpperCase())) {
      hits.push({ route, field, sample: sampleOf(item.trim().toUpperCase()) });
    }
    if (name === "title" && typeof item === "string" && [...suspiciousCodes()].some((code) => item.startsWith(code + DOT))) {
      hits.push({ route, field, sample: sampleOf(item) });
    }
    if (name === "ackStr" || name === "ackStrInfo") hits.push({ route, field, sample: "present" });
    walk(item, field, hits, route, name);
  }
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
  return route.replace(/:([A-Za-z0-9_]+)/g, (_full, name: string) => encodeURIComponent(FILL[name] ?? "t1")).replace(/\*/g, "");
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
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  if (ledgerUrl) process.env.LEDGER_DATABASE_URL = ledgerUrl;
  handle = await createDb();
  await seed(handle.db);
  if (ledgerUrl) {
    pool = await provisionPostgres(ledgerUrl);
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
    await pool.query(
      `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1, $2, 'York FX', 'FINTRAC', 'CAD', 'pack-ca-v1', 1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id = 'pack-ca-v1', home_currency = 'CAD', jurisdiction_pack_version = 1`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
  }
  app = await buildApp(handle.db);
}, 60_000);

afterAll(async () => {
  await app.close();
  await handle.close();
  await pool?.end();
  if (ledgerUrl) delete process.env.LEDGER_DATABASE_URL;
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
    const teller = await cookies("m.costa");
    const tree = app.printRoutes({ commonPrefix: false, method: "GET" });
    const routes = getRoutes(tree);
    expect(routes.length, tree).toBeGreaterThan(0);
    expect(routes).toContain("/api/tenant/state");
    const hits: Hit[] = [];
    for (const route of routes) {
      const url = fill(route);
      const res = await app.inject({ method: "GET", url, cookies: teller });
      console.log(res.statusCode + " " + route);
      const type = String(res.headers["content-type"] ?? "");
      if (res.statusCode < 200 || res.statusCode >= 300 || !type.includes("json")) continue;
      walk(res.json(), "", hits, route, null);
    }
    for (const hit of hits) console.log("LEAK " + hit.route + " " + hit.field + " " + hit.sample);
    expect(hits).toEqual([]);
  }, 60_000);
});
