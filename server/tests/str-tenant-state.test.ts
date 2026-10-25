/* GET and PUT /api/tenant/state.
   STR draft and status stay with administrator, branch manager, and
   compliance officer. The structuring watch and its acknowledgement
   stay with those three plus supervisor. A teller, an auditor, and
   an unknown role get neither. A save from a role without the right
   keeps the stored STR and acknowledgement and still stores the rest. */
import { eq } from "drizzle-orm";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { keepStrSnapshot, presentStrSnapshot, resetStructuringReads, structuringReads } from "../src/state/str-snapshot.js";

const gate = createRequire(import.meta.url)("../../shared/str-role.js") as {
  canSeeStr: (role: string) => boolean;
  canSeeStructuringWatch: (role: string) => boolean;
};
const ROLES = ["administrator", "branch_manager", "compliance_officer", "supervisor", "teller", "auditor", "unknown"];
const DRAFT = "kept under the line";
const ACK = "reviewed by J. Masri";

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function cookie(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

async function asRole(role: string) {
  if (role === "administrator") return cookie("j.masri");
  await handle.db.update(schema.staffUsers).set({ role: role as "teller" }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  return cookie("m.costa");
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "t1", customer: "Nora Quinn", note: "travel",
    strDraft: DRAFT, strStatus: "draft", strTag: "STR", strLink: "filing-1",
    ackStr: true, ackStrInfo: { by: ACK }, structuring: true, structuringTotal: "12000.00",
    ...over,
  };
}

function submissions() {
  return {
    "S-1": { kind: "STR", status: "draft", prompts: { reason: DRAFT } },
    "L-1": { kind: "LCTR", status: "submitted", ackNo: "A1" },
  };
}

function planted(state: Record<string, unknown>, note = "window") {
  return {
    ...state,
    deskNote: note,
    cdos_rows_v1: JSON.stringify([row()]),
    cdos_submissions_v1: JSON.stringify(submissions()),
  };
}

function read(state: Record<string, unknown>) {
  const rows = JSON.parse(String(state.cdos_rows_v1)) as Array<Record<string, unknown>>;
  const subs = JSON.parse(String(state.cdos_submissions_v1)) as Record<string, { prompts?: { reason?: string }; ackNo?: string }>;
  return { line: rows[0]!, subs };
}

function sees(body: string, needle: string, role: string, yes: boolean) {
  if (yes) expect(body, role).toContain(needle);
  else expect(body, role).not.toContain(needle);
}

describe("tenant state STR and structuring fields", () => {
  it("shows and saves STR and the watch only for the roles that may", async () => {
    const owner = await cookie("j.masri");
    for (const role of ROLES) {
      const seeStr = gate.canSeeStr(role);
      const seeWatch = gate.canSeeStructuringWatch(role);
      const opened = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: owner });
      expect(opened.statusCode, opened.body).toBe(200);
      const base = planted(opened.json().state as Record<string, unknown>);
      const saved = await app.inject({
        method: "PUT", url: "/api/tenant/state", cookies: owner,
        payload: { state: base, version: opened.json().version as number },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const version = saved.json().version as number;

      if (role === "unknown") {
        resetStructuringReads();
        const shown = presentStrSnapshot(role, structuredClone(base));
        expect(structuringReads(), role).toBe(0);
        const body = JSON.stringify(shown);
        sees(body, DRAFT, role, false);
        sees(body, ACK, role, false);
        sees(body, "Nora Quinn", role, true);
        sees(body, "LCTR", role, true);
        const sent = planted(base, "from-unknown");
        const rows = JSON.parse(String(sent.cdos_rows_v1)) as Array<Record<string, unknown>>;
        rows[0] = row({ strDraft: "overwrite", ackStr: false, note: "note-unknown" });
        sent.cdos_rows_v1 = JSON.stringify(rows);
        const kept = keepStrSnapshot(role, base, sent) as Record<string, unknown>;
        const held = read(kept);
        expect(kept.deskNote, role).toBe("from-unknown");
        expect(held.line.note, role).toBe("note-unknown");
        expect(held.line.strDraft, role).toBe(DRAFT);
        expect(held.line.ackStr, role).toBe(true);
        expect(held.subs["S-1"]!.prompts!.reason, role).toBe(DRAFT);
        continue;
      }

      resetStructuringReads();
      const cookies = await asRole(role);
      const got = await app.inject({ method: "GET", url: "/api/tenant/state", cookies });
      expect(got.statusCode, got.body).toBe(200);
      const body = got.body;
      sees(body, "Nora Quinn", role, true);
      sees(body, "LCTR", role, true);
      sees(body, DRAFT, role, seeStr);
      sees(body, "strStatus", role, seeStr);
      sees(body, ACK, role, seeWatch);
      sees(body, "structuringTotal", role, seeWatch);
      expect(structuringReads(), role).toBe(seeWatch ? 1 : 0);

      const sent = planted(got.json().state as Record<string, unknown>, `from-${role}`);
      const rows = JSON.parse(String(sent.cdos_rows_v1)) as Array<Record<string, unknown>>;
      rows[0] = row({
        strDraft: "overwrite", strStatus: "filed", strTag: "STR", strLink: "filing-9",
        ackStr: false, ackStrInfo: { by: "overwrite" }, structuring: false, structuringTotal: "1.00",
        note: `note-${role}`,
      });
      sent.cdos_rows_v1 = JSON.stringify(rows);
      const subs = submissions();
      subs["S-1"] = { kind: "STR", status: "filed", prompts: { reason: "overwrite" } };
      subs["L-1"] = { kind: "LCTR", status: "submitted", ackNo: `L-${role}` };
      sent.cdos_submissions_v1 = JSON.stringify(subs);
      const put = await app.inject({
        method: "PUT", url: "/api/tenant/state", cookies,
        payload: { state: sent, version },
      });
      expect(put.statusCode, put.body).toBe(200);

      const after = await app.inject({ method: "GET", url: "/api/tenant/state", cookies: owner });
      expect(after.statusCode, after.body).toBe(200);
      const held = read(after.json().state as Record<string, unknown>);
      expect(after.json().state.deskNote, role).toBe(`from-${role}`);
      expect(held.line.note, role).toBe(`note-${role}`);
      expect(held.subs["L-1"]!.ackNo, role).toBe(`L-${role}`);
      expect(held.line.strDraft, role).toBe(seeStr ? "overwrite" : DRAFT);
      expect(held.line.strStatus, role).toBe(seeStr ? "filed" : "draft");
      expect(held.line.strLink, role).toBe(seeStr ? "filing-9" : "filing-1");
      expect(held.subs["S-1"]!.prompts!.reason, role).toBe(seeStr ? "overwrite" : DRAFT);
      expect(held.line.ackStr, role).toBe(seeWatch ? false : true);
      expect((held.line.ackStrInfo as { by?: string }).by, role).toBe(seeWatch ? "overwrite" : ACK);
      expect(held.line.structuringTotal, role).toBe(seeWatch ? "1.00" : "12000.00");
    }
  });
});
