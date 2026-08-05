/* ============================================================
   The pack proposes, the desk decides — and the gate obeys the desk.

   Three things are being proved here, and the third is the one that
   matters most:

     1. A desk's own thresholds resolve against its real jurisdiction
        pack, in the pack's own currency, and NULL means "follow the
        pack" rather than "no threshold".
     2. Moving one takes a permission and leaves an audit row, because a
        threshold leaves no trace anywhere else — unlike a costing method,
        which an accountant can reconstruct from the lots, the only record
        that a reporting line ever moved is the one written when it moved.
     3. THE IDENTIFICATION GATE REFUSES AT THE DESK'S NUMBER. It used to
        refuse at a literal 3,000 in a comparison against a variable
        called `inputCad`, in a code path documented as jurisdiction
        neutral. A British desk whose pack says 1,000 cleared four deals
        in five that it was obliged to identify.

   Every gate test below is written so it FAILS against the old constant:
   each one picks an amount that lands on the other side of 3,000 (or of
   10,000, for the reporting line) from where the desk's real threshold
   puts it.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { LedgerService, type LedgerActor } from "../src/ledger/service.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";
import { provisionDesk } from "../src/onboarding/provision.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;

async function withClient<T>(run: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------
   Part one: what the desk operates at, and where the answer came from.
   ------------------------------------------------------------ */

const ENTITY = "le-thresholds";
const TENANT = "tnt-thresholds";

async function entityOnPack(packId: string) {
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,jurisdiction,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'Threshold Desk','x',$3,1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id=EXCLUDED.jurisdiction_pack_id`,
    [ENTITY, TENANT, packId],
  );
  await pool.query(
    `UPDATE legal_entities
        SET report_threshold=NULL, id_threshold=NULL,
            aggregation_hours=NULL, retention_years=NULL,
            home_currency=(SELECT home_currency FROM jurisdiction_packs WHERE pack_id=$2)
      WHERE id=$1`,
    [ENTITY, packId],
  );
}

const deskSets = (columns: Record<string, string | number | null>) =>
  pool.query(
    `UPDATE legal_entities SET ${Object.keys(columns)
      .map((name, index) => `${name}=$${index + 2}`)
      .join(",")} WHERE id=$1`,
    [ENTITY, ...Object.values(columns)],
  );

const resolved = () => withClient((client) => readDeskThresholds(client, ENTITY));

postgres("the desk's thresholds, resolved against its pack", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM legal_entities WHERE id=$1", [ENTITY]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => entityOnPack("pack-ca-v1"));

  it("follows the pack until somebody decides otherwise", async () => {
    const desk = await resolved();
    expect(desk.currency).toBe("CAD");
    expect(desk.regulator).toBe("FINTRAC");
    expect(desk.reportName).toBe("LCTR");
    expect(desk.reportThreshold).toEqual({
      effective: "10000.00",
      deskChoice: null,
      packValue: "10000.00",
      posture: "following",
    });
    expect(desk.idThreshold).toEqual({
      effective: "3000.00",
      deskChoice: null,
      packValue: "3000.00",
      posture: "following",
    });
    expect(desk.aggregationHours.effective).toBe(24);
    expect(desk.retentionYears.effective).toBe(5);
  });

  it("states each pack's own figures, in each pack's own currency", async () => {
    /* The point of shipping six packs. A UAE desk reports at 55,000 dirhams
       and identifies at 3,500 of them; the number and the money it is
       counted in both come from the pack, and neither is Canadian. */
    await entityOnPack("pack-ae-v1");
    const uae = await resolved();
    expect(uae.currency).toBe("AED");
    expect(uae.regulator).toBe("CBUAE");
    expect(uae.reportThreshold.effective).toBe("55000.00");
    expect(uae.idThreshold.effective).toBe("3500.00");

    await entityOnPack("pack-gb-v1");
    const british = await resolved();
    expect(british.currency).toBe("GBP");
    expect(british.idThreshold.effective).toBe("1000.00");

    /* Australia keeps records for seven years where everybody else keeps
       them for five, which is the reason retention cannot be a constant
       any more than a threshold can. */
    await entityOnPack("pack-au-v1");
    expect((await resolved()).retentionYears.effective).toBe(7);
  });

  it("calls a tighter line stricter, and says so without alarm", async () => {
    await deskSets({ id_threshold: "1000.00", report_threshold: "7500.00" });
    const desk = await resolved();
    expect(desk.idThreshold).toEqual({
      effective: "1000.00",
      deskChoice: "1000.00",
      packValue: "3000.00",
      posture: "stricter",
    });
    expect(desk.reportThreshold.posture).toBe("stricter");
  });

  it("calls a looser line what it is", async () => {
    await deskSets({ id_threshold: "5000.00", report_threshold: "25000.00" });
    const desk = await resolved();
    expect(desk.idThreshold.posture).toBe("looser");
    expect(desk.reportThreshold.posture).toBe("looser");
  });

  it("distinguishes deferring to the pack from choosing its number", async () => {
    /* Not pedantry. "We never thought about it" and "we looked at 10,000
       and agreed with it" are different states, and only the second
       survives a pack correction — a desk that pinned the figure stays
       where it is when the pack moves, and a desk that deferred follows. */
    await deskSets({ report_threshold: "10000.00" });
    const desk = await resolved();
    expect(desk.reportThreshold.posture).toBe("matching");
    expect(desk.reportThreshold.deskChoice).toBe("10000.00");
  });

  it("knows which way stricter points for a window and for retention", async () => {
    /* The one that reads backwards. A LONGER aggregation window catches
       sets of deals a shorter one lets through, so 48 hours is more
       diligence and 12 is less. Getting this the wrong way round would
       invert the alarm: it would flag the desk running a wider net and say
       nothing to the one running a narrower one. */
    await deskSets({ aggregation_hours: 48, retention_years: 10 });
    let desk = await resolved();
    expect(desk.aggregationHours.posture).toBe("stricter");
    expect(desk.retentionYears.posture).toBe("stricter");

    await deskSets({ aggregation_hours: 12, retention_years: 3 });
    desk = await resolved();
    expect(desk.aggregationHours.posture).toBe("looser");
    expect(desk.retentionYears.posture).toBe("looser");
  });

  it("hands a line back to the pack when the desk clears it", async () => {
    await deskSets({ id_threshold: "1000.00" });
    expect((await resolved()).idThreshold.effective).toBe("1000.00");
    await deskSets({ id_threshold: null });
    const desk = await resolved();
    expect(desk.idThreshold.deskChoice).toBeNull();
    expect(desk.idThreshold.effective).toBe("3000.00");
    expect(desk.idThreshold.posture).toBe("following");
  });

  it("answers null — not zero — when nothing can state a line", async () => {
    /* A pack authored with a zero threshold. Zero is ambiguous in the
       worst way: "identify everybody" to one reader and "no line stated"
       to the next, and those are opposites at the gate. So it resolves to
       nothing at all, which is loud and fixable. */
    await pool.query(
      `INSERT INTO jurisdiction_packs
         (pack_id,jurisdiction,version,name,home_currency,regulator,
          report_name,report_threshold,id_threshold,report_currency)
       VALUES ('pack-silent-v1','Z0',1,'Unstated','CAD','NOBODY','NIL',0,0,'CAD')
       ON CONFLICT (pack_id) DO NOTHING`,
    );
    await entityOnPack("pack-silent-v1");
    const desk = await resolved();
    expect(desk.idThreshold.effective).toBeNull();
    expect(desk.idThreshold.posture).toBe("unknown");
    expect(desk.reportThreshold.effective).toBeNull();
  });
});

/* ------------------------------------------------------------
   Part one and a half: the answer given at sign-up becomes a real line.

   "When should the desk ask for ID?" is screen four of onboarding, and the
   answer used to land in `tenants.setup` and stop there — the browser read
   it once into its own state and the ledger never saw it. Now it lands on
   the legal entity, where the posting path resolves it.
   ------------------------------------------------------------ */

postgres("what a desk is given at sign-up", () => {
  /* Provisioning is onConflictDoNothing — a retry after a dropped
     connection finishes the job rather than half-failing — so a desk left
     behind by an earlier run would silently be the desk this test read.
     Cleared in foreign-key order first, which is the only way to see what
     THIS run's provisioning did. */
  const clearDesk = async (slug: string) => {
    const entity = `le-${slug}`;
    await pool.query(
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE legal_entity_id=$1)",
      [entity],
    );
    for (const table of ["staff_users", "workspaces", "rate_boards", "branches"])
      await pool.query(`DELETE FROM ${table} WHERE legal_entity_id=$1`, [entity]);
    await pool.query("DELETE FROM legal_entities WHERE id=$1", [entity]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [`tnt-${slug}`]);
  };

  const provisioned = async (slug: string, setup: Record<string, unknown>) => {
    await clearDesk(slug);
    await provisionDesk(
      handle.db,
      {
        businessName: `Desk ${slug}`,
        legalName: `Desk ${slug} Inc.`,
        ownerName: "Owner",
        email: `${slug}@example.test`,
        slug,
        plan: "pro",
        setup,
        msbNumber: null,
        regulator: String(setup.regulator ?? "FINTRAC"),
        team: [],
      },
      "hash",
      "test",
    );
    return (
      await pool.query("SELECT id_threshold FROM legal_entities WHERE id=$1", [
        `le-${slug}`,
      ])
    ).rows[0];
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("records a real tightening as the desk's own line", async () => {
    /* FINTRAC identifies at 3,000. This owner said 1,000, which is them
       asking more of their shop than the law does — a decision, and one
       the ledger has to be able to enforce the next morning. */
    const row = await provisioned("thr-strict", {
      country: "CA",
      regulator: "FINTRAC",
      idThreshold: 1000,
    });
    expect(row.id_threshold).toBe("1000.00");
  });

  it.each([
    ["the legal minimum, chosen as such", 10000],
    ["a figure above the mandate", 5000],
    ["the mandate itself", 3000],
  ])("leaves the desk following the pack for %s", async (name, chosen) => {
    /* None of these is a tightening. The picker's top option is worded
       "the legal minimum — nothing extra", which is a desk saying "follow
       my regulator"; recorded as an override it would stop that desk ever
       being moved by a pack correction. And a figure above the pack's
       cannot be honoured as an identification line at all — it would put a
       desk out of compliance on the day it opened. */
    const row = await provisioned(
      `thr-follow-${chosen}`,
      { country: "CA", regulator: "FINTRAC", idThreshold: chosen },
    );
    expect(row.id_threshold, name).toBeNull();
  });

  it("leaves it alone when onboarding never asked", async () => {
    const row = await provisioned("thr-silent", { country: "CA" });
    expect(row.id_threshold).toBeNull();
  });
});

/* ------------------------------------------------------------
   Part two: the gate. Does the ledger refuse at the DESK's number?
   ------------------------------------------------------------ */

const GATE_TENANT = "tnt-gate";
const GATE_ENTITY = "le-gate";
const actor: LedgerActor = {
  userId: "gate-teller",
  tenantId: GATE_TENANT,
  legalEntityId: GATE_ENTITY,
  branchId: "br-gate",
  workspaceId: "ws-gate",
  tillId: "till-gate",
  role: "teller",
  authorizedBranchIds: ["br-gate"],
};
const gateScope = [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

/* Two packs, both with a tradeable home currency, carrying the figures
   this is really about.

   `post()`'s currency type is still the pilot's four codes, so a desk
   whose book is kept in dirhams cannot be driven through it. Rather than
   widen the enum for a test, the UAE's FIGURES ride on a GBP book: what
   is being proved is that the gate uses the pack's number rather than
   3,000, and the number is the interesting half. That the currency comes
   from the pack too is proved above, against the real AE pack. */
const PACKS = `
  INSERT INTO jurisdiction_packs
    (pack_id,jurisdiction,version,name,home_currency,regulator,
     report_name,report_threshold,id_threshold,report_currency)
  VALUES
    ('pack-gate-tight-v1','G1',1,'Tight','GBP','TIGHTREG','MLR',10000,1000,'GBP'),
    ('pack-gate-loose-v1','G2',1,'Loose','GBP','LOOSEREG','STR',55000,3500,'GBP'),
    ('pack-gate-silent-v1','G3',1,'Silent','GBP','NOBODY','NIL',0,0,'GBP')
  ON CONFLICT (pack_id) DO NOTHING`;

async function gateReset(packId: string) {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
    [GATE_TENANT],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'Gate Desk','x','GBP',$3,1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id=EXCLUDED.jurisdiction_pack_id`,
    [GATE_ENTITY, GATE_TENANT, packId],
  );
  await pool.query(
    `UPDATE legal_entities
        SET report_threshold=NULL, id_threshold=NULL, jurisdiction_pack_id=$2
      WHERE id=$1`,
    [GATE_ENTITY, packId],
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1,$2,$3,$4,$5,$6,'teller','[\"br-gate\"]')",
    [actor.userId, ...gateScope],
  );
  /* One customer nobody has identified and one who is verified. The gate
     is only ever about the first. */
  await pool.query(
    `INSERT INTO ledger_customers VALUES
       ('cust-unknown',$1,$2,$3,$4,'Walk-in','Normal','unverified'),
       ('cust-known',$1,$2,$3,$4,'Regular','Normal','verified')`,
    gateScope.slice(0, 4),
  );
  /* Rates against the book's own currency, which is GBP here — the column
     is called units_per_cad because renaming it is not free. */
  await pool.query(
    `INSERT INTO ledger_rates VALUES
       ($1,$2,$3,$4,'GBP',1),($1,$2,$3,$4,'USD',1.25),
       ($1,$2,$3,$4,'CAD',1.7),($1,$2,$3,$4,'EUR',1.15)`,
    gateScope.slice(0, 4),
  );
  for (const [currency, amount] of [
    ["GBP", 400000],
    ["USD", 400000],
    ["CAD", 400000],
    ["EUR", 400000],
  ] as const)
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...gateScope, currency, amount],
    );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-gate',$1,$2,$3,$4,$5,1,current_date,'open',$6,now())`,
    [...gateScope, actor.userId],
  );
}

let gate: LedgerService;
let deal = 0;

/** A GBP-in deal of `amount`, from a customer with the given ID status. */
const sell = (
  amount: string,
  customerId = "cust-unknown",
  extra: { purpose?: string; sourceOfFunds?: string } = {},
) =>
  gate.post(actor, {
    idempotencyKey: `gate-${++deal}`,
    customerId,
    from: "GBP",
    to: "USD",
    inputAmount: amount,
    feeCad: "0.00",
    purpose: "Personal travel",
    sourceOfFunds: "Employment income",
    ...extra,
  });

const blocked = async (promise: Promise<unknown>, message?: RegExp) => {
  await expect(promise).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  if (message) await expect(promise).rejects.toThrow(message);
};

postgres("the identification gate refuses at the desk's own number", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(PACKS);
    gate = new LedgerService(pool);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM legal_entities WHERE id=$1", [GATE_ENTITY]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => gateReset("pack-gate-tight-v1"));

  it("refuses at the PACK's line, which is not three thousand", async () => {
    /* 1,500 on a desk whose pack identifies at 1,000. The old code
       compared against a hardcoded 3,000 and posted this deal without
       anybody having seen the customer's ID. */
    await blocked(sell("1500.00"));
    expect(
      (await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count,
    ).toBe("0");

    // and below the line it goes through, unbothered
    await expect(sell("900.00")).resolves.toMatchObject({ transactionId: expect.any(String) });
  });

  it("clears a deal the old constant refused, when the pack allows it", async () => {
    /* The mirror image, and the reason a constant is not merely
       incomplete but wrong in both directions: a desk identifying at
       3,500 was refusing perfectly good business at 3,000. */
    await gateReset("pack-gate-loose-v1");
    await expect(sell("3000.00")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    await blocked(sell("3600.00"));
  });

  it("refuses at the DESK's line the moment the desk tightens it", async () => {
    /* The owner's whole point: not just at sign-up. This desk follows a
       pack that identifies at 1,000, decides 250 is where it wants to be,
       and the very next deal is judged there. */
    await expect(sell("400.00")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    await pool.query("UPDATE legal_entities SET id_threshold='250.00' WHERE id=$1", [
      GATE_ENTITY,
    ]);
    await blocked(sell("400.00"));
  });

  it("lets a desk that loosens past its pack post what its pack would refuse", async () => {
    /* Not an endorsement — the desk is told, unmissably, that it is
       non-compliant. But the gate enforces the number the desk actually
       operates at, because a gate that quietly enforced something else
       would make the posture display a lie. */
    await pool.query("UPDATE legal_entities SET id_threshold='9000.00' WHERE id=$1", [
      GATE_ENTITY,
    ]);
    await expect(sell("5000.00")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it("never stops a verified customer, whatever the line is", async () => {
    await pool.query("UPDATE legal_entities SET id_threshold='1.00' WHERE id=$1", [
      GATE_ENTITY,
    ]);
    await expect(sell("5000.00", "cust-known")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it("refuses an unidentified customer when nothing can state a line, and says why", async () => {
    /* The null case, decided rather than defaulted. A gate that never
       fires clears deals nobody checked; this one refuses, and the message
       names the real problem instead of reading as a compliance failure
       by the person at the counter. */
    await gateReset("pack-gate-silent-v1");
    await blocked(sell("50.00"), /no identification threshold/i);
  });

  it("still trades on a verified customer when nothing can state a line", async () => {
    /* The other half of that decision. A customer who is already
       identified satisfies every possible value of a line nobody can
       state, so there is nothing to be unsure about — and a
       misconfigured pack does not close the shop. */
    await gateReset("pack-gate-silent-v1");
    await expect(sell("50000.00", "cust-known")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it("asks for purpose and source of funds at the desk's REPORTING line", async () => {
    /* The other hardcoded number in the same condition: 10,000, on a book
       that might be kept in dirhams where the figure is 55,000. This
       pack reports at 10,000; 12,000 without the details is refused, and
       the same deal with them is fine. */
    const bare = { purpose: "  ", sourceOfFunds: "  " };
    await blocked(sell("12000.00", "cust-known", bare));
    await expect(sell("12000.00", "cust-known")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    // under the line, the details are the desk's business and not ours
    await expect(sell("9000.00", "cust-known", bare)).resolves.toMatchObject({
      transactionId: expect.any(String),
    });

    // and the desk may pull that line down too
    await pool.query(
      "UPDATE legal_entities SET report_threshold='5000.00' WHERE id=$1",
      [GATE_ENTITY],
    );
    await blocked(sell("6000.00", "cust-known", bare));
  });
});

/* ------------------------------------------------------------
   Part two and a half: the same gate on the path the desk actually uses.

   Everything above drives `post()`, the direct path. Every deal a teller
   makes goes through a frozen quote instead, and the hardcoded 3,000 was
   in BOTH — so proving one and not the other proves nothing about the
   product. This walks a quote from the route that creates it to the route
   that posts it, which is the sequence the New Transaction screen runs.
   ------------------------------------------------------------ */

postgres("the gate on the frozen-quote path", () => {
  const scope = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];

  const quoteFor = async (inputAmount: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies: await cookieFor("m.costa"),
        payload: {
          customerId: "cust-unknown",
          from: "CAD",
          to: "USD",
          inputAmount,
          feeCad: "0.00",
          direction: "customer_buy_foreign",
        },
      })
    ).json();

  const postQuote = async (quoteId: string, key: string) =>
    app.inject({
      method: "POST",
      url: `/api/quotes/${quoteId}/post`,
      cookies: await cookieFor("m.costa"),
      payload: {
        idempotencyKey: key,
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query(
      "UPDATE legal_entities SET report_threshold=NULL,id_threshold=NULL",
    );
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
    );
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
      [DEMO.tenantId],
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool.query(
      "UPDATE legal_entities SET report_threshold=NULL,id_threshold=NULL,jurisdiction_pack_id='pack-ca-v1' WHERE id=$1",
      [DEMO.legalEntityId],
    );
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
      [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query(
      "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]')",
      scope,
    );
    /* Nobody has identified this one, which is the only interesting case. */
    await pool.query(
      "INSERT INTO ledger_customers VALUES ('cust-unknown',$1,$2,$3,$4,'Walk-in','Normal','unverified')",
      scope.slice(0, 4),
    );
    for (const [currency, amount] of [
      ["CAD", 90000],
      ["USD", 90000],
      ["EUR", 9000],
      ["GBP", 9000],
    ] as const)
      await pool.query(
        "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [...scope, currency, amount],
      );
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ('session-q',$1,$2,$3,$4,$5,1,current_date,'open',$1||':m.costa',now())`,
      scope,
    );
    await pool.query(
      "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-q','test','{\"USD\":1.4,\"EUR\":1.5,\"GBP\":1.7}',now())",
    );
    await pool.query(
      'INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at) VALUES (\'board-q\',$1,$2,$3,0.02,0.03,\'{"USD":{"mid":1.4,"show":true},"EUR":{"mid":1.5,"show":true},"GBP":{"mid":1.7,"show":true}}\',\'snap-q\',now())',
      scope.slice(0, 3),
    );
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "teller", authorizedBranchIds: [DEMO.branchId] })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  });

  it("posts a quote under the pack's line and refuses one over the desk's", async () => {
    /* 2,000 Canadian dollars: over nothing at the pack's 3,000, and over
       everything once this desk decides 1,500 is where it wants to be. */
    const under = await quoteFor("2000.00");
    expect((await postQuote(under.quoteId, "quote-under")).statusCode).toBe(201);

    await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { idThreshold: "1500.00" },
      cookies: await cookieFor("j.masri"),
    });

    const over = await quoteFor("2000.00");
    const refused = await postQuote(over.quoteId, "quote-over");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("COMPLIANCE_BLOCKED");
    /* The refusal has to have stopped the POSTING, not merely returned a
       status: a fixture that fires and forgets is how a swallowed 500
       passes for a passing test. */
    expect(
      (await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count,
    ).toBe("1");
  });
});

/* ------------------------------------------------------------
   Part three: changing a line through the desk — who may, and what it
   leaves behind.
   ------------------------------------------------------------ */

async function cookieFor(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

const auditRows = () =>
  pool.query(
    "SELECT actor_id,target_id,reason FROM ledger_audit_events WHERE action='compliance.thresholds.change' ORDER BY created_at",
  );

postgres("moving the line through the desk", () => {
  const scope = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query("TRUNCATE ledger_audit_events,ledger_principals CASCADE");
    await pool.query(
      "UPDATE legal_entities SET report_threshold=NULL,id_threshold=NULL,aggregation_hours=NULL,retention_years=NULL",
    );
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ledger_audit_events,ledger_principals CASCADE");
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING",
      [DEMO.tenantId],
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,jurisdiction,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','FINTRAC','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool.query(
      `UPDATE legal_entities
          SET report_threshold=NULL,id_threshold=NULL,
              aggregation_hours=NULL,retention_years=NULL,
              jurisdiction_pack_id='pack-ca-v1'
        WHERE id=$1`,
      [DEMO.legalEntityId],
    );
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES
        ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
        ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]'),
        ($1||':m.costa',$1,$2,$3,$4,$5,'compliance_officer','["br-yorkville"]')`,
      scope,
    );
    for (const [staffId, role] of [
      ["a.singh", "teller"],
      ["r.haddad", "branch_manager"],
      ["m.costa", "compliance_officer"],
    ] as const) {
      await handle.db
        .update(schema.staffUsers)
        .set({ role, authorizedBranchIds: [DEMO.branchId] })
        .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staffId}`));
    }
  });

  it("reports the lines and where each answer came from", async () => {
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: await cookieFor("a.singh"),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      currency: "CAD",
      regulator: "FINTRAC",
      reportName: "LCTR",
      reportThreshold: {
        effective: "10000.00",
        deskChoice: null,
        packValue: "10000.00",
        posture: "following",
      },
      idThreshold: { effective: "3000.00", posture: "following" },
    });
  });

  it("lets a compliance officer tighten a line, and writes down who did it", async () => {
    const changed = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { idThreshold: "1000.00" },
      cookies: await cookieFor("m.costa"),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().idThreshold).toEqual({
      effective: "1000.00",
      deskChoice: "1000.00",
      packValue: "3000.00",
      posture: "stricter",
    });
    // the untouched line is left exactly where it was
    expect(changed.json().reportThreshold.deskChoice).toBeNull();

    const audit = await auditRows();
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_id).toBe(`${DEMO.tenantId}:m.costa`);
    expect(audit.rows[0].target_id).toBe(DEMO.legalEntityId);
    expect(audit.rows[0].reason).toBe(
      "identification threshold pack default (3000.00) → 1000.00 (stricter)",
    );
  });

  it("records a loosened line as loosened, in the row an auditor reads", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { reportThreshold: "25000.00" },
      cookies: await cookieFor("r.haddad"),
    });
    const audit = await auditRows();
    expect(audit.rows[0].reason).toBe(
      "reporting threshold pack default (10000.00) → 25000.00 (looser)",
    );
  });

  it("changes several lines at once and audits the set", async () => {
    const changed = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { aggregationHours: 48, retentionYears: 10 },
      cookies: await cookieFor("r.haddad"),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().aggregationHours).toEqual({
      effective: 48,
      deskChoice: 48,
      packValue: 24,
      posture: "stricter",
    });
    expect(changed.json().retentionYears.effective).toBe(10);
    expect((await auditRows()).rows[0].reason).toBe(
      "aggregation window (hours) pack default (24) → 48 (stricter); " +
        "record retention (years) pack default (5) → 10 (stricter)",
    );
  });

  it("hands a line back to the pack when asked, and says that happened", async () => {
    const cookies = await cookieFor("r.haddad");
    await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { idThreshold: "1000.00" },
      cookies,
    });
    const released = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { idThreshold: "pack_default" },
      cookies,
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().idThreshold.deskChoice).toBeNull();
    expect(released.json().idThreshold.effective).toBe("3000.00");
    const audit = await auditRows();
    expect(audit.rowCount).toBe(2);
    expect(audit.rows[1].reason).toBe(
      "identification threshold 1000.00 → pack default (3000.00) (following)",
    );
  });

  it("refuses a teller, and changes nothing", async () => {
    const denied = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload: { idThreshold: "1000.00" },
      cookies: await cookieFor("a.singh"),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("AUTHORIZATION_DENIED");
    expect(
      (
        await pool.query("SELECT id_threshold FROM legal_entities WHERE id=$1", [
          DEMO.legalEntityId,
        ])
      ).rows[0].id_threshold,
    ).toBeNull();
    expect((await auditRows()).rowCount).toBe(0);
  });

  it("lets a teller read the line they are working to", async () => {
    /* Refusing the read would be the wrong lesson from refusing the write.
       Everybody at the counter needs to know when to ask for ID. */
    const read = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: await cookieFor("a.singh"),
    });
    expect(read.statusCode).toBe(200);
  });

  it.each([
    ["a threshold of nothing", { idThreshold: "0" }],
    ["a negative threshold", { idThreshold: "-500.00" }],
    ["a threshold that is not a number", { idThreshold: "lots" }],
    ["a window of no hours", { aggregationHours: 0 }],
    ["a field nobody defined", { homeCurrency: "USD" }],
    ["nothing at all", {}],
  ])("refuses %s", async (_name, payload) => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      payload,
      cookies: await cookieFor("r.haddad"),
    });
    expect(bad.statusCode).toBe(400);
    expect((await auditRows()).rowCount).toBe(0);
  });

  it("will not answer at all without a session", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/ledger/desk-thresholds" }))
        .statusCode,
    ).toBe(401);
  });
});
