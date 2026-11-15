/* The daily fetch is started with the real Postgres pool. A Drizzle handle
   alone does not rescreen, so this test calls the same function listenServer uses. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { startSanctionsFetch } from "../src/screening/fetch.js";
import { LIST_SOURCES } from "../src/screening/sources.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const canada = readFileSync(join(here, "fixtures/sanctions/canada.xml"), "utf8")
  .replace("</data-set>", `<record><LastName-NomDeFamille>Wiring</LastName-NomDeFamille><GivenName-Prenom>Subject</GivenName-Prenom><Schedule-Annexe>1</Schedule-Annexe><Item-NumeroDarticle>900</Item-NumeroDarticle></record></data-set>`);
const un = readFileSync(join(here, "fixtures/sanctions/un.xml"), "utf8");
const page = readFileSync(join(here, "fixtures/sanctions/public-safety.html"), "utf8");

postgres("sanctions fetch startup", () => {
  let handle: DbHandle;
  let pool: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    if (!handle.pool) throw new Error("startup wiring needs the Postgres pool");
    pool = handle.pool;
    await seed(handle.db);
    await pool.query(
      `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name, kind, created_by, updated_by)
       VALUES ('cli-wiring',$1,$2,'Wiring Subject','individual','seed','seed')
       ON CONFLICT (client_id) DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM sanctions_reviews WHERE client_id = 'cli-wiring'");
    await pool.query("DELETE FROM sanctions_screenings WHERE client_id = 'cli-wiring'");
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await handle.close();
    delete process.env.DATABASE_URL;
  });

  it("re-screens existing customers when a fetched list changes", async () => {
    const started = startSanctionsFetch(handle.db, handle.pool, async (target) => {
      const address = String(target);
      if (address === LIST_SOURCES[0]!.url) return { ok: true, status: 200, body: canada };
      if (address === LIST_SOURCES[1]!.url) return { ok: true, status: 200, body: un };
      return { ok: true, status: 200, body: page };
    });
    await started.ready;
    started.stop();
    const reviews = await pool.query(
      "SELECT status FROM sanctions_reviews WHERE client_id = 'cli-wiring' AND status = 'open'",
    );
    expect(reviews.rowCount).toBeGreaterThan(0);
  });
});
