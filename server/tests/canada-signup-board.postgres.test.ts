/* Canada with no homeCurrency in the body still gets a CAD board and a quote. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const SLUG = "ca-only-board";
const EMAIL = "owner@ca-only-board.example";
const TENANT = `tnt-${SLUG}`;
const ENTITY = `le-${SLUG}`;
const BRANCH = `br-${SLUG}-main`;

let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
let logged: string[] = [];
let earlyAccess: string | undefined;

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((entry) => entry.includes("[email simulated]"));
  const match = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!match) throw new Error("no signup code in log");
  return match[1]!;
};

async function removeDesk() {
  await pool.query(
    "DELETE FROM quote_events WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)",
    [TENANT],
  );
  await pool.query(
    "DELETE FROM quote_overrides WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)",
    [TENANT],
  );
  await pool.query("DELETE FROM quotes WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM ledger_customers WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM ledger_principals WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM desk_clients WHERE tenant_id=$1", [TENANT]);
  await pool.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE tenant_id=$1)",
    [TENANT],
  );
  await pool.query("DELETE FROM staff_users WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM rate_boards WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM workspaces WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM branches WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM legal_entities WHERE id=$1", [ENTITY]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id=$1", [TENANT]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [TENANT]);
  await pool.query("DELETE FROM pending_signups WHERE email=$1", [EMAIL]);
}

postgres("a Canada signup with no home currency", () => {
  beforeAll(async () => {
    earlyAccess = process.env.EARLY_ACCESS_OPEN;
    process.env.EARLY_ACCESS_OPEN = "1";
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    await removeDesk();
  });

  afterAll(async () => {
    await removeDesk();
    await app.close();
    await handle.close();
    await pool.end();
    vi.restoreAllMocks();
    if (earlyAccess === undefined) delete process.env.EARLY_ACCESS_OPEN;
    else process.env.EARLY_ACCESS_OPEN = earlyAccess;
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
  });

  it("publishes a CAD starting board and can quote", async () => {
    logged = [];
    const signup = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Harbour FX",
        ownerName: "Casey Harbour",
        email: EMAIL,
        password: "a-strong-pass",
        slug: SLUG,
        onboarding: { country: "Canada" },
      },
    });
    expect(signup.statusCode, signup.body).toBe(201);

    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: EMAIL, code: codeFromLog() },
    });
    expect(verified.statusCode, verified.body).toBe(201);
    const cookie = verified.cookies.find((item) => item.name === "cdos_session");
    expect(cookie?.value).toBeTruthy();

    const entity = (
      await pool.query(
        "SELECT home_currency, jurisdiction_pack_id FROM legal_entities WHERE id=$1",
        [ENTITY],
      )
    ).rows[0];
    expect(String(entity.home_currency).trim()).toBe("CAD");
    expect(entity.jurisdiction_pack_id).toBe("pack-ca-v1");

    const boards = (
      await pool.query(
        "SELECT board_rows FROM rate_boards WHERE branch_id=$1",
        [BRANCH],
      )
    ).rows;
    expect(boards).toHaveLength(1);
    expect(boards[0].board_rows.USD).toBeTruthy();
    expect(boards[0].board_rows.CAD).toBeUndefined();

    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies: { cdos_session: cookie!.value },
      payload: { legalName: "Walk In" },
    });
    expect(client.statusCode, client.body).toBe(201);
    const counter = await app.inject({
      method: "POST",
      url: `/api/clients/${client.json().clientId}/counter-record`,
      cookies: { cdos_session: cookie!.value },
    });
    expect(counter.statusCode, counter.body).toBe(200);

    const quote = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: { cdos_session: cookie!.value },
      payload: {
        customerId: counter.json().customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        direction: "customer_buy_foreign",
      },
    });
    expect(quote.statusCode, quote.body).toBe(201);
    expect(quote.json().from).toBe("CAD");
    expect(quote.json().to).toBe("USD");
  });
});
