/* Reserve at 0 is refused. Reserve, settle, and release are idempotent.
   Settle after release is refused. Update and delete are refused.
   Shop A cannot read or write shop B. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { grant, readCredits, release, reserve, settle } from "../src/idv/credit-ledger.js";
const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const B_TENANT = "tnt-idv-credit-b";
const B_SHOP = "le-idv-credit-b";
const B_BRANCH = "br-idv-credit-b";
const B_USER = `${B_TENANT}:b.owner`;
let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
const cookies: Record<string, { cdos_session: string }> = {};
const freshShop = () => `idv-credit-${randomUUID()}`;
async function signIn(staffId: string, tenantId: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { cdos_session: res.cookies.find((entry) => entry.name === "cdos_session")!.value };
}
async function countType(shopId: string, entryType: string) {
  const found = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM idv_credit_ledger WHERE shop_id = $1 AND entry_type = $2",
    [shopId, entryType],
  );
  return Number(found.rows[0]?.n ?? 0);
}
const hit = (method: "GET" | "POST", who: string, extra?: { payload?: object; shopId?: string }) =>
  app.inject({
    method,
    url: extra?.shopId ? `/api/idv/credits?shopId=${extra.shopId}` : "/api/idv/credits",
    cookies: cookies[who],
    ...(extra?.payload ? { payload: extra.payload } : {}),
  });
postgres("idv credit ledger", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await seed(handle.db);
    app = await buildApp(handle.db);
    await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'Shop B') ON CONFLICT DO NOTHING", [B_TENANT]);
    await pool.query("INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Shop B') ON CONFLICT DO NOTHING", [B_SHOP, B_TENANT]);
    await pool.query("INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Desk B') ON CONFLICT DO NOTHING", [B_BRANCH, B_TENANT, B_SHOP]);
    await pool.query(
      `INSERT INTO staff_users (id, tenant_id, legal_entity_id, branch_id, staff_id, name, role, authorized_branch_ids, password_hash)
       SELECT $1, $2, $3, $4, 'b.owner', 'B Owner', 'administrator', '[]'::jsonb, password_hash
       FROM staff_users WHERE staff_id = 'j.masri' AND tenant_id = $5 ON CONFLICT DO NOTHING`,
      [B_USER, B_TENANT, B_SHOP, B_BRANCH, DEMO.tenantId],
    );
    cookies.owner = await signIn("j.masri", DEMO.tenantId);
    cookies.teller = await signIn("m.costa", DEMO.tenantId);
    cookies.b = await signIn("b.owner", B_TENANT);
  });
  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM sessions WHERE user_id = $1", [B_USER]);
      await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [B_TENANT]);
      await pool.query("DELETE FROM staff_users WHERE id = $1", [B_USER]);
      await pool.query("DELETE FROM branches WHERE id = $1", [B_BRANCH]);
      await pool.query("DELETE FROM legal_entities WHERE id = $1", [B_SHOP]);
      await pool.query("DELETE FROM tenants WHERE id = $1", [B_TENANT]);
      await pool.end();
    }
    if (app) await app.close();
    if (handle) await handle.close();
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });
  it("refuses a reserve when the balance is 0", async () => {
    const shopId = freshShop();
    await expect(reserve(pool, shopId, randomUUID(), "tester")).rejects.toMatchObject({ code: "NO_CREDIT" });
    expect(await countType(shopId, "reserve")).toBe(0);
    expect((await readCredits(pool, shopId)).balance).toBe(0);
  });
  it("returns the same reserve and writes no second row", async () => {
    const shopId = freshShop();
    const inquiryId = randomUUID();
    await grant(pool, shopId, 1, "tester");
    const first = await reserve(pool, shopId, inquiryId, "tester");
    expect(await reserve(pool, shopId, inquiryId, "other")).toEqual(first);
    expect(first.balance).toBe(0);
    expect(await countType(shopId, "reserve")).toBe(1);
    await expect(reserve(pool, shopId, randomUUID(), "tester")).rejects.toMatchObject({ code: "NO_CREDIT" });
  });
  it("settles one credit once, and only after a reserve", async () => {
    const shopId = freshShop();
    const inquiryId = randomUUID();
    await expect(settle(pool, shopId, inquiryId, "tester")).rejects.toMatchObject({ code: "NO_RESERVE" });
    await grant(pool, shopId, 1, "tester");
    await reserve(pool, shopId, inquiryId, "tester");
    const first = await settle(pool, shopId, inquiryId, "tester");
    expect(await settle(pool, shopId, inquiryId, "other")).toEqual(first);
    expect(first).toMatchObject({ amount: 0, balance: 0, entryType: "settle", inquiryId });
    expect(await countType(shopId, "settle")).toBe(1);
    await expect(release(pool, shopId, inquiryId, "tester")).rejects.toMatchObject({ code: "CLOSED" });
    expect(await countType(shopId, "release")).toBe(0);
  });
  it("releases a reserve once and frees the credit", async () => {
    const shopId = freshShop();
    const inquiryId = randomUUID();
    await expect(release(pool, shopId, inquiryId, "tester")).rejects.toMatchObject({ code: "NO_RESERVE" });
    await grant(pool, shopId, 2, "tester");
    await reserve(pool, shopId, inquiryId, "tester");
    const first = await release(pool, shopId, inquiryId, "tester");
    expect(await release(pool, shopId, inquiryId, "other")).toEqual(first);
    expect(first).toMatchObject({ amount: 1, balance: 2, entryType: "release" });
    expect(await countType(shopId, "release")).toBe(1);
  });
  it("refuses settle after release", async () => {
    const shopId = freshShop();
    const inquiryId = randomUUID();
    await grant(pool, shopId, 1, "tester");
    await reserve(pool, shopId, inquiryId, "tester");
    await release(pool, shopId, inquiryId, "tester");
    await expect(settle(pool, shopId, inquiryId, "tester")).rejects.toMatchObject({ code: "CLOSED" });
    expect(await countType(shopId, "settle")).toBe(0);
    expect((await readCredits(pool, shopId)).balance).toBe(1);
    await expect(pool.query(
      "INSERT INTO idv_credit_ledger (shop_id, entry_type, amount, inquiry_id, actor) VALUES ($1, 'settle', 0, $2, 'x')",
      [shopId, inquiryId],
    )).rejects.toThrow(/unique/);
  });
  it("rejects an update and a delete", async () => {
    const shopId = freshShop();
    await grant(pool, shopId, 1, "tester");
    await expect(pool.query("UPDATE idv_credit_ledger SET amount = 2 WHERE shop_id = $1", [shopId])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM idv_credit_ledger WHERE shop_id = $1", [shopId])).rejects.toThrow(/append-only/);
    expect(await countType(shopId, "grant")).toBe(1);
    expect((await readCredits(pool, shopId)).balance).toBe(1);
  });
  it("shop A cannot read shop B", async () => {
    const beforeA = (await readCredits(pool, DEMO.legalEntityId)).balance;
    const beforeB = (await readCredits(pool, B_SHOP)).balance;
    await grant(pool, B_SHOP, 7, B_USER);
    const mine = await hit("GET", "owner");
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().balance).toBe(beforeA);
    expect(JSON.stringify(mine.json())).not.toContain(B_USER);
    const theirs = await hit("GET", "owner", { shopId: B_SHOP });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().code).toBe("SCOPE_DENIED");
    const teller = await hit("GET", "teller");
    expect(teller.statusCode).toBe(403);
    expect(teller.json().code).toBe("AUTHORIZATION_DENIED");
    const own = await hit("GET", "b");
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().balance).toBe(beforeB + 7);
    expect(own.json().entries.some((entry: { actor: string }) => entry.actor === B_USER)).toBe(true);
  });
  it("shop A cannot write shop B", async () => {
    const beforeA = (await readCredits(pool, DEMO.legalEntityId)).balance;
    const beforeB = (await readCredits(pool, B_SHOP)).balance;
    const denied = await hit("POST", "owner", { payload: { shopId: B_SHOP, amount: 4 } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("SCOPE_DENIED");
    expect((await readCredits(pool, B_SHOP)).balance).toBe(beforeB);
    const teller = await hit("POST", "teller", { payload: { amount: 4 } });
    expect(teller.statusCode).toBe(403);
    expect(teller.json().code).toBe("AUTHORIZATION_DENIED");
    expect((await readCredits(pool, DEMO.legalEntityId)).balance).toBe(beforeA);
    const granted = await hit("POST", "owner", { payload: { amount: 3 } });
    expect(granted.statusCode, granted.body).toBe(201);
    expect(granted.json().balance).toBe(beforeA + 3);
    expect((await readCredits(pool, B_SHOP)).balance).toBe(beforeB);
    const crossed = await hit("POST", "b", { payload: { shopId: DEMO.legalEntityId, amount: 5 } });
    expect(crossed.statusCode).toBe(403);
    expect((await readCredits(pool, DEMO.legalEntityId)).balance).toBe(beforeA + 3);
  });
});
