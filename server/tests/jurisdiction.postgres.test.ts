/* ============================================================
   Selling this outside Canada.

   The book was built for one country and said so in its column names —
   fee_cad, spread_cad, amount_cad. A London desk cannot use a ledger whose
   idea of money is Canadian, and the goal is to sell this anywhere by
   plugging in a pack.

   So these tests do the thing the old design document listed as its
   acceptance criteria: stand up entities in different jurisdictions and
   check that each one keeps its books in its own currency, applies its own
   regulator's thresholds, and cannot see the others'.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  packForCountry,
  pairAllowed,
  resolvePack,
} from "../src/ledger/jurisdiction.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

async function entity(id: string, country: string) {
  const pack = packForCountry(country);
  if (!pack) throw new Error(`This test expected a pack for ${country}.`);
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
    [`tnt-${id}`],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,$1,'x',$3,$4,$5) ON CONFLICT DO NOTHING`,
    [id, `tnt-${id}`, pack.homeCurrency, pack.packId, pack.version],
  );
  return pack;
}

const withClient = async <T,>(run: (c: pg.PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try { return await run(client); } finally { client.release(); }
};

postgres("jurisdiction packs against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("keeps each desk's books in its own currency", async () => {
    await entity("le-jur-ca", "CA");
    await entity("le-jur-gb", "GB");
    await entity("le-jur-us", "US");

    const packs = await withClient(async (client) => ({
      ca: await resolvePack(client, "le-jur-ca"),
      gb: await resolvePack(client, "le-jur-gb"),
      us: await resolvePack(client, "le-jur-us"),
    }));

    expect(packs.ca.homeCurrency).toBe("CAD");
    expect(packs.gb.homeCurrency).toBe("GBP");
    expect(packs.us.homeCurrency).toBe("USD");
    // and each answers to its own regulator, with its own reporting name
    expect(packs.ca.regulator).toBe("FINTRAC");
    expect(packs.gb.regulator).toBe("HMRC");
    expect(packs.us.regulator).toBe("FinCEN");
    expect(packs.ca.reportName).toBe("LCTR");
    expect(packs.gb.reportName).toBe("SAR");
    expect(packs.us.reportName).toBe("CTR");
  });

  it("applies the identification threshold the jurisdiction actually uses", async () => {
    const packs = await withClient(async (client) => ({
      ca: await resolvePack(client, "le-jur-ca"),
      gb: await resolvePack(client, "le-jur-gb"),
    }));
    /* Canada asks for identification at 3,000. A new United Kingdom desk
       is on pack-gb-v2, whose occasional line is 12,000. The published
       v1 row is still 1,000. Wiring either in as a constant is exactly
       how a desk ends up out of compliance in a country nobody tested. */
    expect(Number(packs.ca.idThreshold)).toBe(3000);
    expect(packs.gb.packId).toBe("pack-gb-v2");
    expect(Number(packs.gb.idThreshold)).toBe(12000);
    const v1 = await pool.query(
      `SELECT report_name, report_threshold::text, id_threshold::text
         FROM jurisdiction_packs WHERE pack_id='pack-gb-v1'`,
    );
    expect(v1.rows[0]).toEqual({
      report_name: "MLR",
      report_threshold: "10000.00",
      id_threshold: "1000.00",
    });
  });

  it("lets a desk trade one foreign currency for another", async () => {
    const gb = await withClient((c) => resolvePack(c, "le-jur-gb"));
    // a customer in London with dollars, wanting euros — no GBP in the middle
    expect(pairAllowed(gb, "USD", "EUR")).toEqual({ ok: true });
    // and the ordinary case still works both directions
    expect(pairAllowed(gb, "GBP", "USD")).toEqual({ ok: true });
    expect(pairAllowed(gb, "USD", "GBP")).toEqual({ ok: true });
  });

  it("refuses a cross-currency deal where the pack does not permit one", async () => {
    await pool.query(
      "UPDATE jurisdiction_packs SET allow_cross_currency=false WHERE pack_id='pack-us-v1'",
    );
    const us = await withClient((c) => resolvePack(c, "le-jur-us"));
    const refused = pairAllowed(us, "CAD", "EUR");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/USD/);
    // its own home currency still trades freely
    expect(pairAllowed(us, "USD", "EUR")).toEqual({ ok: true });
    await pool.query(
      "UPDATE jurisdiction_packs SET allow_cross_currency=true WHERE pack_id='pack-us-v1'",
    );
  });

  it("refuses a deal with the same currency on both sides", async () => {
    const ca = await withClient((c) => resolvePack(c, "le-jur-ca"));
    expect(pairAllowed(ca, "CAD", "CAD").ok).toBe(false);
  });

  it("gives an entity with no pack the currency it already booked in", async () => {
    /* A database that predates all of this. It must not be told it is
       Canadian on the strength of nothing — if it has a home currency, that
       is the answer. */
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ('tnt-jur-old','old') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,jurisdiction,home_currency)
       VALUES ('le-jur-old','tnt-jur-old','old','x','EUR') ON CONFLICT DO NOTHING`,
    );
    const pack = await withClient((c) => resolvePack(c, "le-jur-old"));
    expect(pack.homeCurrency).toBe("EUR");
    /* No country pack. The baseline applies, and it is not Canada's.
       The regulator stays blank. FINTRAC would be a claim. */
    expect(pack.available).toBe(true);
    expect(pack.baseline).toBe(true);
    expect(pack.packId).toBe("pack-intl-v1");
    expect(pack.packId).not.toBe("pack-ca-v1");
    expect(pack.regulator).toBe("");
    expect(pack.regulator).not.toBe("FINTRAC");
    expect(pack.reportName).toBe("CASH-RECORD");
    const desk = await withClient((c) => readDeskThresholds(c, "le-jur-old"));
    expect(desk.regulator).toBe("");
    expect(desk.regulator).not.toBe("FINTRAC");
    expect(desk.reportName).toBe("CASH-RECORD");
    expect(desk.currency).toBe("EUR");
    expect(desk.aggregationHours.effective).toBe(24);
    expect(desk.retentionYears.effective).toBe(5);
  });
});
