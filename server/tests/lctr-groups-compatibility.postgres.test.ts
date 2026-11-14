/* CD107 Opus F1/F2 regressions. Synthetic data in a fresh disposable PG only. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { createSession } from "../src/auth/sessions.js";
import { buildApp } from "../src/app.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import { shopDayWindow } from "../src/ledger/canada-rules.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const day = "2026-06-15";
postgres("LCTR read compatibility and historical boundaries", () => {
  let pool: pg.Pool, handle: DbHandle, app: FastifyInstance;
  let entity: string, tenant: string, branch: string, user: string, pack: string;
  let version = 100;
  let cookies: { cdos_session: string };
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("LEDGER_DATABASE_URL", url!);
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url, max: 1 });
    app = await buildApp(handle.db);
  }, 60_000);
  afterAll(async () => {
    await app?.close(); await handle?.close(); await pool?.end(); vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    const id = randomUUID();
    tenant = `compat-t-${id}`; entity = `compat-e-${id}`; branch = `compat-b-${id}`;
    user = `compat-u-${id}`; pack = `compat-pack-${id}`;
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Synthetic compatibility')", [tenant]);
    await pool.query("INSERT INTO legal_entities(id,tenant_id,name,home_currency,jurisdiction_pack_id) VALUES ($1,$2,'Synthetic','CAD','pack-ca-v2')", [entity, tenant]);
    await pool.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name,timezone) VALUES ($1,$2,$3,'Synthetic','America/Toronto')", [branch, tenant, entity]);
    await pool.query(`INSERT INTO staff_users(id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash)
      VALUES ($1,$2,$3,$4,$1,'Synthetic','administrator',$5,'not-a-login-hash')`, [user, tenant, entity, branch, JSON.stringify([branch])]);
    await pool.query("INSERT INTO workspaces(id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$4,'synthetic-till')", [entity, tenant, entity, branch]);
    await ensureLedgerPrincipal(pool, { userId: user, tenantId: tenant, legalEntityId: entity, branchId: branch, workspaceId: entity, tillId: "synthetic-till", role: "administrator", authorizedBranchIds: [branch] });
    cookies = { cdos_session: (await createSession(handle.db, user)).token };
  });
  async function read(on = day) {
    const response = await app.inject({ method: "GET", url: `/api/ledger/lctr-groups?day=${on}`, cookies });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function receipt(amount: string, at = `${day}T16:00:00Z`, cash = amount, out = "0.00") {
    const id = randomUUID();
    const home = (await pool.query("SELECT home_currency FROM legal_entities WHERE id=$1", [entity])).rows[0].home_currency;
    await pool.query(`INSERT INTO ledger_transactions
      (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,
       from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at,
       deal_kind,received_instrument,disbursed_instrument,cash_in_home,cash_out_home,home_currency,third_party,third_party_name)
      VALUES ($1,$1,$2,$3,$4,'synthetic-w','synthetic-till','conductor',$5,$10,'USD',$6,$6,1,0,0,'Synthetic','Synthetic',$7,
       'exchange','cash','cash',$8,$9,$10,true,' Third Party ')`, [id, tenant, entity, branch, user, amount, at, cash, out, home]);
    await pool.query(`INSERT INTO ledger_obligations
      (obligation_id,obligation_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,transaction_id,kind,direction,
       counterparty,face_currency,face_amount,home_currency,carrying_amount_home,status,opened_at,created_by,beneficiary_name)
      VALUES ($1,$1,$2,$3,$4,'synthetic-w','synthetic-till','conductor',$1,'remittance_payable','payable','Synthetic','CAD',$6,'CAD',$6,'open',$7,$5,' Beneficiary ')`,
    [id, tenant, entity, branch, user, amount, at]);
    return id;
  }
  // Clone canonical stored fields into isolated rows; never mutate a seeded pack.
  async function customRule(changes: Record<string, unknown> = {}, home = "CAD") {
    await pool.query(`INSERT INTO jurisdiction_packs SELECT (jsonb_populate_record(NULL::jurisdiction_packs,
      to_jsonb(p) || jsonb_build_object('pack_id',$1::text,'home_currency',$2::text,'jurisdiction','ZZ','version',$3::int))).* FROM jurisdiction_packs p WHERE pack_id='pack-ca-v2'`, [pack, home, version++]);
    await pool.query(`INSERT INTO jurisdiction_reports SELECT (jsonb_populate_record(NULL::jurisdiction_reports,
      to_jsonb(r) || $1::jsonb)).* FROM jurisdiction_reports r WHERE report_id='rpt-ca-lctr-v2'`,
    [JSON.stringify({ ...changes, pack_id: pack, report_id: `${pack}-report` })]);
    await pool.query("UPDATE legal_entities SET jurisdiction_pack_id=$1,home_currency=$2 WHERE id=$3", [pack, home, entity]);
  }
  it.each(["pack-ca-v1", "pack-us-v1", "pack-au-v2", "pack-rs-v1", "pack-in-v1", "pack-ph-v1", "pack-intl-v1", null])(
    "keeps groups but refuses reportability for unsupported stored pack %s", async selected => {
      await pool.query("UPDATE legal_entities SET jurisdiction_pack_id=$1,home_currency=COALESCE((SELECT home_currency FROM jurisdiction_packs WHERE pack_id=$1),'CAD'),report_threshold=1 WHERE id=$2", [selected, entity]);
      const rule = await pool.query("SELECT trigger_threshold FROM jurisdiction_reports WHERE pack_id=$1 AND kind='large_cash' ORDER BY version DESC LIMIT 1", [selected ?? "pack-intl-v1"]);
      const half = String(Number(rule.rows[0].trigger_threshold) / 2);
      const ids = [await receipt(half), await receipt(half)];
      // Cash out remains excluded from receipt groups; unknown must not clear it.
      await receipt("9999999.00", undefined, "0.00", "9999999.00");
      const result = await read();
      expect(result.trigger).toBeNull();
      expect(result.groups).toHaveLength(3);
      for (const group of result.groups) expect(group).toMatchObject({ total: Number(rule.rows[0].trigger_threshold).toFixed(2), transactionIds: ids.sort(), needsReport: null });
    },
  );
  it.each([
    { aggregate_all_amounts: false }, { comparator: "gt" }, { direction: "both" }, { direction: "out" }, { direction: null },
    { cash_only: false }, { trigger_currency: "USD" }, { trigger_currency: null },
    { window_kind: "calendar_month" }, { window_kind: "rolling_days", window_days: 7 },
    { window_kind: "banking_day" }, { window_kind: "none" }, { threshold_currency: "USD" },
  ])("does not let a desk override supply unsupported semantics: %j", async changes => {
    await customRule(changes);
    await pool.query("UPDATE legal_entities SET report_threshold=1 WHERE id=$1", [entity]);
    await receipt("10000.00");
    const result = await read();
    expect(result.trigger).toBeNull();
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every((g: { needsReport: unknown }) => g.needsReport === null)).toBe(true);
  });
  it.each([null, "", "CAD"])("accepts an absent or book-denominated threshold currency: %j", async currency => {
    await customRule({ threshold_currency: currency });
    await receipt("10000.00");
    const result = await read();
    expect(result.trigger).toBe("10000.00");
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every((g: { needsReport: unknown }) => g.needsReport === true)).toBe(true);
  });
  it.each([{ axes: null }, { axes: ["conductor"] }, { axes: ["on_behalf_of", "beneficiary"] }])("only evaluates explicitly listed axes %j", async ({ axes }) => {
    await customRule({ aggregation_axes: axes });
    await receipt("10000.00");
    const result = await read();
    expect(result.trigger).toBe("10000.00");
    expect(result.groups).toHaveLength(3);
    for (const group of result.groups) expect(group.needsReport).toBe(axes?.includes(group.axis) ? true : null);
  });
  it.each([[null, "10000.00", false], ["20000.00", "10000.00", false], ["5000.00", "5000.00", true]] as const)(
    "preserves canonical comparison and desk tightening for %s without country-name gating", async (desk, trigger, hit) => {
      await customRule({ trigger_currency: "USD", threshold_currency: "USD" }, "USD");
      await pool.query("UPDATE legal_entities SET report_threshold=$1 WHERE id=$2", [desk, entity]);
      await receipt("6000.00");
      const result = await read();
      expect(result.trigger).toBe(trigger);
      expect(result.groups).toHaveLength(3);
      expect(result.groups.every((g: { needsReport: unknown }) => g.needsReport === hit)).toBe(true);
    },
  );
  it("compares the exact trigger inclusively for a compatible canonical rule", async () => {
    await customRule();
    await receipt("5000.00"); await receipt("4999.99");
    expect((await read()).groups.every((g: { needsReport: unknown }) => g.needsReport === false)).toBe(true);
    await receipt("0.01");
    expect((await read()).groups.every((g: { needsReport: unknown }) => g.needsReport === true)).toBe(true);
  });
  it.each(["America/Toronto", "America/Nassau"])("assigns historical receipts to the correct civil day in %s", async zone => {
    await pool.query("UPDATE legal_entities SET timezone=$1 WHERE id=$2", [zone, entity]);
    const before = await receipt("1.00", "1919-03-31T04:29:59.999Z");
    const start = await receipt("2.00", "1919-03-31T04:30:00.000Z");
    const after = await receipt("4.00", "1919-03-31T04:45:00.000Z");
    const last = await receipt("8.00", "1919-04-01T03:59:59.999Z");
    const next = await receipt("16.00", "1919-04-01T04:00:00.000Z");
    const previous = await read("1919-03-30"), current = await read("1919-03-31"), following = await read("1919-04-01");
    expect(current.window).toEqual({ start: "1919-03-31T04:30:00.000Z", end: "1919-04-01T04:00:00.000Z", startOffset: "-04:00", endOffset: "-04:00" });
    expect(previous.window.end).toBe(current.window.start);
    expect(following.window.start).toBe(current.window.end);
    for (const group of previous.groups) expect(group).toMatchObject({ total: "1.00", transactionIds: [before] });
    for (const group of current.groups) expect(group).toMatchObject({ total: "14.00", transactionIds: [start, after, last].sort() });
    for (const group of following.groups) expect(group).toMatchObject({ total: "16.00", transactionIds: [next] });
    expect([previous.groups.length, current.groups.length, following.groups.length]).toEqual([3, 3, 3]);
  });
});

describe("shop-day boundary controls", () => {
  it.each(["America/Toronto", "America/Nassau"])("resolves a midnight-straddling gap at its actual transition in %s", zone => {
    const previous = shopDayWindow("1919-03-30", zone), current = shopDayWindow("1919-03-31", zone);
    expect(previous.end.toISOString()).toBe("1919-03-31T04:30:00.000Z");
    expect(current.start).toEqual(previous.end);
    expect(previous.endOffset).toBe("-04:00");
  });
  it.each(["0000-01-01", "10000-01-01", "1900-02-29", "2026-02-30", "2026-6-15", " 2026-06-15", "2026-06-15T00:00:00Z"])("keeps strict civil validity: %s", invalid => {
    expect(() => shopDayWindow(invalid, "America/Toronto")).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
  it.each(["0001-01-01", "0099-12-31", "2000-02-29", "9999-12-31"])("keeps the full civil range in a non-UTC zone: %s", valid => {
    const window = shopDayWindow(valid, "Asia/Kathmandu");
    expect(window.end.getTime() - window.start.getTime()).toBe(86400000);
    expect(window.start.getTime() + (valid < "1900" ? 20476000 : 20700000)).toBe(new Date(`${valid}T00:00:00Z`).getTime());
  });
});
