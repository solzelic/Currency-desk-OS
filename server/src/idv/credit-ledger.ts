/* Provider-neutral identity-check credits. The balance is the sum of amount. */
import pg from "pg";
export type IdvCreditType = "grant" | "reserve" | "settle" | "release";
export type IdvCreditResult = {
  shopId: string; entryType: IdvCreditType; amount: number; inquiryId: string | null; balance: number;
};
export type IdvCreditEntry = {
  entryType: IdvCreditType; amount: number; inquiryId: string | null; createdAt: string; actor: string;
};
type Refusal = "NO_CREDIT" | "NO_RESERVE" | "CLOSED" | "BAD_AMOUNT";
type Hit = { shop_id: string };
type Client = pg.PoolClient;
export class IdvCreditRefused extends Error {
  readonly code: Refusal;
  constructor(code: Refusal) {
    super(code);
    this.name = "IdvCreditRefused";
    this.code = code;
  }
}
async function withShop<T>(pool: pg.Pool, shopId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`idv-credit:${shopId}`]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function balanceOf(client: Client, shopId: string): Promise<number> {
  const found = await client.query<{ balance: number }>(
    "SELECT COALESCE(SUM(amount), 0)::int AS balance FROM idv_credit_ledger WHERE shop_id = $1",
    [shopId],
  );
  return Number(found.rows[0]?.balance ?? 0);
}
async function lookup(client: Client, entryType: IdvCreditType, inquiryId: string): Promise<Hit | undefined> {
  const found = await client.query<Hit>(
    "SELECT shop_id FROM idv_credit_ledger WHERE entry_type = $1 AND inquiry_id = $2",
    [entryType, inquiryId],
  );
  return found.rows[0];
}
async function outcome(client: Client, shopId: string, entryType: IdvCreditType, amount: number, inquiryId: string | null) {
  return { shopId, entryType, amount, inquiryId, balance: await balanceOf(client, shopId) };
}
async function insert(client: Client, shopId: string, entryType: IdvCreditType, amount: number, inquiryId: string | null, actor: string) {
  await client.query(
    "INSERT INTO idv_credit_ledger (shop_id, entry_type, amount, inquiry_id, actor) VALUES ($1, $2, $3, $4, $5)",
    [shopId, entryType, amount, inquiryId, actor],
  );
}
function inquiryOf(inquiryId: string): string {
  if (typeof inquiryId !== "string" || inquiryId.length === 0) throw new IdvCreditRefused("BAD_AMOUNT");
  return inquiryId;
}
export async function grant(pool: pg.Pool, shopId: string, amount: number, actor: string): Promise<IdvCreditResult> {
  if (!Number.isInteger(amount) || amount < 1) throw new IdvCreditRefused("BAD_AMOUNT");
  return withShop(pool, shopId, async (client) => {
    await insert(client, shopId, "grant", amount, null, actor);
    return outcome(client, shopId, "grant", amount, null);
  });
}
/* Holds 1 credit. A second call for the same inquiry returns the first result. */
export async function reserve(pool: pg.Pool, shopId: string, inquiryId: string, actor: string): Promise<IdvCreditResult> {
  const inquiry = inquiryOf(inquiryId);
  return withShop(pool, shopId, async (client) => {
    const prior = await lookup(client, "reserve", inquiry);
    if (prior) {
      if (prior.shop_id !== shopId) throw new IdvCreditRefused("CLOSED");
      return outcome(client, shopId, "reserve", -1, inquiry);
    }
    if (await balanceOf(client, shopId) < 1) throw new IdvCreditRefused("NO_CREDIT");
    await insert(client, shopId, "reserve", -1, inquiry, actor);
    return outcome(client, shopId, "reserve", -1, inquiry);
  });
}
async function close(pool: pg.Pool, shopId: string, inquiryId: string, actor: string, entryType: "settle" | "release", amount: number) {
  const inquiry = inquiryOf(inquiryId);
  const other: "settle" | "release" = entryType === "settle" ? "release" : "settle";
  return withShop(pool, shopId, async (client) => {
    const prior = await lookup(client, entryType, inquiry);
    if (prior) {
      if (prior.shop_id !== shopId) throw new IdvCreditRefused("CLOSED");
      return outcome(client, shopId, entryType, amount, inquiry);
    }
    if (await lookup(client, other, inquiry)) throw new IdvCreditRefused("CLOSED");
    const held = await lookup(client, "reserve", inquiry);
    if (!held || held.shop_id !== shopId) throw new IdvCreditRefused("NO_RESERVE");
    await insert(client, shopId, entryType, amount, inquiry, actor);
    return outcome(client, shopId, entryType, amount, inquiry);
  });
}
/* A completed pass or decline. The reserved credit stays spent. */
export function settle(pool: pg.Pool, shopId: string, inquiryId: string, actor: string) {
  return close(pool, shopId, inquiryId, actor, "settle", 0);
}
/* An abandoned, failed, or expired check. The reserved credit comes back. */
export function release(pool: pg.Pool, shopId: string, inquiryId: string, actor: string) {
  return close(pool, shopId, inquiryId, actor, "release", 1);
}
export async function readCredits(pool: pg.Pool, shopId: string): Promise<{ balance: number; entries: IdvCreditEntry[] }> {
  const found = await pool.query<{
    entry_type: IdvCreditType; amount: number; inquiry_id: string | null; created_at: Date; actor: string;
  }>(
    "SELECT entry_type, amount, inquiry_id, created_at, actor FROM idv_credit_ledger WHERE shop_id = $1 ORDER BY id",
    [shopId],
  );
  const entries = found.rows.map((row) => ({
    entryType: row.entry_type,
    amount: Number(row.amount),
    inquiryId: row.inquiry_id,
    createdAt: new Date(row.created_at).toISOString(),
    actor: row.actor,
  }));
  return { balance: entries.reduce((sum, entry) => sum + entry.amount, 0), entries };
}
