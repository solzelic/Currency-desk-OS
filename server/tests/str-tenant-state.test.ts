/* GET and PUT /api/tenant/state.
   A suspicious report stays with administrator, branch manager, and
   compliance officer. ackStr stays with those three plus supervisor. */
import { eq } from "drizzle-orm";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/migrations.js";
import { keepStrSnapshot, presentStrSnapshot, suspiciousCodes } from "../src/state/str-snapshot.js";

const gate = createRequire(import.meta.url)("../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  canSeeStructuringWatch: (role: string) => boolean;
};
const ROLES = ["administrator", "branch_manager", "compliance_officer", "supervisor", "teller", "auditor", "unknown"];
const ACK = "reviewed by J. Masri";
const SMR = "pattern kept under the line";
const NOKIND = "no kind on the saved entry";
const PREP = "prepared worksheet";
const HIST = "Suspicious Matter Report · Nora Quinn";
const TITLE = "STR · Nora Quinn";
const STR_NEEDLES = [SMR, NOKIND, PREP, HIST, TITLE];
type Sub = { prompts?: { reason?: string }; ackNo?: string; kind?: string; status?: string };

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); });

async function cookie(staffId: string) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId } });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}
async function asRole(role: string) {
  if (role === "administrator") return cookie("j.masri");
  await handle.db.update(schema.staffUsers).set({ role: role as "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  return cookie("m.costa");
}

function sub(over: Record<string, unknown>) {
  return { status: "submitted", by: "J. Masri", groupId: "STR-Nora Quinn", ticks: {}, ...over };
}
function bundle() {
  return {
    rows: [{ id: "t1", customer: "Nora Quinn", note: "travel", type: "Currency Exchange", status: "posted", filed: false, filedInfo: null, ackStr: true, ackStrInfo: { by: ACK, at: "2026-10-25 15:00" } }],
    subs: {
      "STR-Nora Quinn-AB12": sub({ kind: "SMR", ackNo: "SMR-1", prompts: { reason: SMR }, ticks: { grounds: true }, sealed: { reportId: "STR-Nora Quinn-AB12", kind: "SMR", basis: "structuring", subject: "Nora Quinn" } }),
      "STR-Nora Quinn-NOKIND": sub({ ackNo: "NK-1", prompts: { reason: NOKIND }, sealed: { basis: "structuring", subject: "Nora Quinn" } }),
      "STR-Nora Quinn-PREP": sub({ status: "prepared", kind: "STR", prompts: { reason: PREP }, sealed: { kind: "STR", basis: "structuring" } }),
      "L-LT1": sub({ kind: "LCTR", ackNo: "A1", groupId: "L-LT1", prompts: {}, sealed: { kind: "LCTR", basis: "customer", subject: "Nora Quinn" } }),
    } as Record<string, Record<string, unknown>>,
    hist: [
      { key: "F1", type: "SMR", title: HIST, filing: true, subject: "Nora Quinn", ack: "SMR-1" },
      { key: "F3", type: "STR", title: TITLE, filing: true, subject: "Nora Quinn", ack: "STR-1" },
      { key: "F2", type: "LCTR", title: "Large Cash Transaction Report · Nora Quinn", filing: true, subject: "Nora Quinn", ack: "A1" },
      { key: "K1", type: "KYC", title: "KYC verification · Nora Quinn", subject: "Nora Quinn" },
    ],
  };
}
function planted(state: Record<string, unknown>, note = "window", book = bundle()) {
  return { ...state, deskNote: note, cdos_rows_v1: JSON.stringify(book.rows), cdos_submissions_v1: JSON.stringify(book.subs), cdos_report_history_v1: JSON.stringify(book.hist) };
}
function read(state: Record<string, unknown>) {
  return {
    line: (JSON.parse(String(state.cdos_rows_v1)) as Array<Record<string, unknown>>)[0]!,
    subs: JSON.parse(String(state.cdos_submissions_v1)) as Record<string, Sub>,
    hist: JSON.parse(String(state.cdos_report_history_v1)) as Array<{ key: string; title: string; type?: string }>,
  };
}
function sees(body: string, needle: string, role: string, yes: boolean) {
  if (yes) expect(body, role).toContain(needle);
  else expect(body, role).not.toContain(needle);
}
async function saveBase() {
  const cookies = await cookie("j.masri");
  const opened = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
  expect(opened.statusCode, opened.body).toBe(200);
  const saved = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies, payload: { state: planted(opened.json().state as Record<string, unknown>), version: opened.json().version as number } });
  expect(saved.statusCode, saved.body).toBe(200);
  return { base: planted(opened.json().state as Record<string, unknown>), version: saved.json().version as number };
}

describe("tenant state STR and acknowledgement", () => {
  it("shows and saves a suspicious report only for the roles that may", async () => {
    for (const role of ROLES) {
      const seeStr = gate.canSeeStr(role);
      const seeWatch = gate.canSeeStructuringWatch(role);
      const { base, version } = await saveBase();
      const sent = planted(base, `from-${role}`);
      const rows = JSON.parse(String(sent.cdos_rows_v1)) as Array<Record<string, unknown>>;
      rows[0] = { ...rows[0], ackStr: false, ackStrInfo: { by: "overwrite" }, note: `note-${role}` };
      sent.cdos_rows_v1 = JSON.stringify(rows);
      const subs = JSON.parse(String(sent.cdos_submissions_v1)) as Record<string, Record<string, unknown>>;
      subs["STR-Nora Quinn-AB12"] = { ...subs["STR-Nora Quinn-AB12"], prompts: { reason: "overwrite" } };
      subs["L-LT1"] = { ...subs["L-LT1"], ackNo: `L-${role}` };
      sent.cdos_submissions_v1 = JSON.stringify(subs);
      if (role === "unknown") {
        const body = JSON.stringify(presentStrSnapshot(role, structuredClone(base)));
        for (const needle of STR_NEEDLES) sees(body, needle, role, false);
        sees(body, ACK, role, false);
        sees(body, "Nora Quinn", role, true);
        sees(body, "LCTR", role, true);
        sees(body, "KYC verification", role, true);
        const kept = read(keepStrSnapshot(role, base, sent) as Record<string, unknown>);
        expect(kept.line.note, role).toBe(`note-${role}`);
        expect(kept.line.ackStr, role).toBe(true);
        expect(kept.subs["STR-Nora Quinn-AB12"]!.prompts!.reason, role).toBe(SMR);
        expect(kept.subs["L-LT1"]!.ackNo, role).toBe(`L-${role}`);
        continue;
      }
      const cookies = await asRole(role);
      const got = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
      expect(got.statusCode, got.body).toBe(200);
      sees(got.body, "Nora Quinn", role, true);
      sees(got.body, "LCTR", role, true);
      sees(got.body, "Large Cash Transaction Report", role, true);
      sees(got.body, "KYC verification", role, true);
      for (const needle of STR_NEEDLES) sees(got.body, needle, role, seeStr);
      sees(got.body, ACK, role, seeWatch);
      const put = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies, payload: { state: sent, version } });
      expect(put.statusCode, put.body).toBe(200);
      const after = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: await cookie("j.masri") });
      const held = read(after.json().state as Record<string, unknown>);
      expect(after.json().state.deskNote, role).toBe(`from-${role}`);
      expect(held.line.note, role).toBe(`note-${role}`);
      expect(held.subs["L-LT1"]!.ackNo, role).toBe(`L-${role}`);
      expect(held.subs["STR-Nora Quinn-AB12"]!.prompts!.reason, role).toBe(seeStr ? "overwrite" : SMR);
      expect(held.subs["STR-Nora Quinn-NOKIND"]!.prompts!.reason, role).toBe(NOKIND);
      expect(held.hist.some((item) => item.title === HIST), role).toBe(true);
      expect(held.line.ackStr, role).toBe(seeWatch ? false : true);
      expect((held.line.ackStrInfo as { by?: string } | null)?.by, role).toBe(seeWatch ? "overwrite" : ACK);
    }
  });

  it("keeps a stored STR and acknowledgement when a teller save drops them", async () => {
    const { base, version } = await saveBase();
    const book = bundle();
    const row = { ...book.rows[0]!, note: "still the deal" } as Record<string, unknown>;
    delete row.ackStr;
    delete row.ackStrInfo;
    book.rows = [row as typeof book.rows[0]];
    delete book.subs["STR-Nora Quinn-AB12"];
    delete book.subs["STR-Nora Quinn-NOKIND"];
    delete book.subs["STR-Nora Quinn-PREP"];
    book.hist = book.hist.filter((item) => item.type === "LCTR" || item.type === "KYC");
    const put = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: await asRole("teller"), payload: { state: planted(base, "teller-drop", book), version } });
    expect(put.statusCode, put.body).toBe(200);
    const held = read((await app.inject({ method: "GET", url: "/api/tenant/state", cookies: await cookie("j.masri") })).json().state);
    expect(held.line.note).toBe("still the deal");
    expect(held.line.ackStr).toBe(true);
    expect((held.line.ackStrInfo as { by: string }).by).toBe(ACK);
    expect(held.subs["STR-Nora Quinn-AB12"]!.prompts!.reason).toBe(SMR);
    expect(held.subs["STR-Nora Quinn-NOKIND"]!.prompts!.reason).toBe(NOKIND);
    expect(held.subs["STR-Nora Quinn-PREP"]!.status).toBe("prepared");
    expect(held.hist.some((item) => item.key === "F1")).toBe(true);
    expect(held.subs["L-LT1"]!.ackNo).toBe("A1");
  });

  it("does not store an STR a teller adds", async () => {
    const { base, version } = await saveBase();
    const book = bundle();
    book.subs["STR-Nora Quinn-NEW"] = sub({ kind: "SMR", ackNo: "NEW-1", by: "M. Costa", prompts: { reason: "added by a teller" }, sealed: { kind: "SMR", basis: "structuring" } });
    const put = await app.inject({ method: "PUT", url: "/api/tenant/state", cookies: await asRole("teller"), payload: { state: planted(base, "teller-add", book), version } });
    expect(put.statusCode, put.body).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/tenant/state", cookies: await cookie("j.masri") })).json();
    const held = read(body.state);
    expect(held.subs["STR-Nora Quinn-NEW"]).toBeUndefined();
    expect(body.state.deskNote).toBe("teller-add");
    expect(held.subs["STR-Nora Quinn-AB12"]!.kind).toBe("SMR");
  });
  it("parsed suspicious codes match jurisdiction_reports", async () => {
    const db = (handle.db as unknown as { $client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>; exec: (text: string) => Promise<unknown> } }).$client;
    const q = async (text: string, params?: unknown[]) => {
      if (!params) { await db.exec(text); return { rows: [], rowCount: 0 }; }
      const result = await db.query(text, params); return { rows: result.rows, rowCount: result.rows.length };
    };
    await runMigrations({ query: q, connect: async () => ({ query: q, release() {} }) } as never);
    const cols = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'jurisdiction_reports' AND column_name IN ('kind', 'category')");
    const found = await db.query("SELECT DISTINCT code FROM jurisdiction_reports WHERE " + cols.rows.map((row) => String(row.column_name) + " = 'suspicious'").join(" OR "));
    expect([...suspiciousCodes()].sort()).toEqual(found.rows.map((row) => String(row.code).toUpperCase()).sort());
  });
});
