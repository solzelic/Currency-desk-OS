/* ============================================================
   Product-demo desk — York FX only.

   Sol signs in at /login as staff id `demo` and should see a lived-in
   shop: customers, a published board, an open till, and posted history.
   Platform /admin is the wrong surface for that sit-down.

   Two independent jobs:

     1. ensureDemoStaff — create staff id `demo` on York FX if missing.
        Password is applied only from DEMO_STAFF_BOOTSTRAP, and only when
        the account is new or has never had a password stamped
        (passwordUpdatedAt is null). An existing demo password is never
        overwritten. Same spirit as PLATFORM_ADMIN_BOOTSTRAP (#31).

     2. populateDemoDesk — when DEMO_POPULATE=1 (or a caller invokes it),
        post a small already-saved set through the real ledger / quote /
        client-record services. Stable idempotency keys make a second
        boot a no-op. The function hard-codes the York FX demo scope and
        refuses to run unless that tenant is present with siteSlug
        `yorkfx`. It never accepts a tenant id from the caller.

   No secrets belong in this file, in logs, or in git. Log the env var
   name; never the password.
   ============================================================ */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { hashPassword } from "./auth/password.js";
import { ClientRecordService } from "./clients/records.js";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { LedgerProvisioningService } from "./ledger/provisioning.js";
import { ensureLedgerPrincipal } from "./ledger/principal.js";
import { LedgerError, type LedgerActor } from "./ledger/service.js";
import { TillControlService } from "./ledger/till-control.js";
import { QuoteService, boardMaxAgeSeconds } from "./quotes/service.js";
import { DEMO } from "./seed.js";

export const DEMO_STAFF_ID = "demo";
export const DEMO_STAFF_NAME = "Demo Teller";
export const DEMO_TILL_ID = "till-01";

const DEMO_IDEMPOTENCY_PREFIX = "demo-desk:";

export type DemoStaffResult = "created" | "password_set" | "exists" | "no-tenant";

export type DemoPopulateResult = {
  status: "populated" | "already" | "skipped";
  reason?: string;
  customers: number;
  transactions: number;
  posted: number;
  reused: number;
  tillOpen: boolean;
};

type DemoCustomerSpec = {
  slug: string;
  name: string;
  dateOfBirth: string;
  city: string;
  region: string;
  postalCode: string;
  occupation: string;
  phone: string;
  docNumber: string;
};

type DemoDealSpec = {
  key: string;
  customerSlug: string;
  from: "CAD" | "USD" | "EUR";
  to: "CAD" | "USD" | "EUR";
  inputAmount: string;
  feeCad: string;
  purpose: string;
  sourceOfFunds: string;
};

const DEMO_CUSTOMERS: readonly DemoCustomerSpec[] = [
  {
    slug: "lina-farah",
    name: "Lina Farah",
    dateOfBirth: "1988-03-14",
    city: "Toronto",
    region: "ON",
    postalCode: "M5R 1B8",
    occupation: "Designer",
    phone: "416-555-0142",
    docNumber: "HG847291",
  },
  {
    slug: "omar-haddad",
    name: "Omar Haddad",
    dateOfBirth: "1979-11-02",
    city: "Mississauga",
    region: "ON",
    postalCode: "L5B 3C2",
    occupation: "Contractor",
    phone: "647-555-0198",
    docNumber: "AB120334",
  },
  {
    slug: "priya-nair",
    name: "Priya Nair",
    dateOfBirth: "1992-07-21",
    city: "Toronto",
    region: "ON",
    postalCode: "M4S 1Y5",
    occupation: "Accountant",
    phone: "437-555-0166",
    docNumber: "CN559810",
  },
  {
    slug: "james-okonkwo",
    name: "James Okonkwo",
    dateOfBirth: "1985-01-09",
    city: "North York",
    region: "ON",
    postalCode: "M2N 5W9",
    occupation: "Engineer",
    phone: "416-555-0177",
    docNumber: "KA771203",
  },
];

const DEMO_DEALS: readonly DemoDealSpec[] = [
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:1`,
    customerSlug: "lina-farah",
    from: "USD",
    to: "CAD",
    inputAmount: "350.00",
    feeCad: "3.00",
    purpose: "Travel",
    sourceOfFunds: "Savings",
  },
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:2`,
    customerSlug: "omar-haddad",
    from: "CAD",
    to: "USD",
    inputAmount: "400.00",
    feeCad: "4.00",
    purpose: "Family support",
    sourceOfFunds: "Employment income",
  },
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:3`,
    customerSlug: "priya-nair",
    from: "CAD",
    to: "EUR",
    inputAmount: "275.00",
    feeCad: "3.50",
    purpose: "Holiday",
    sourceOfFunds: "Employment income",
  },
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:4`,
    customerSlug: "lina-farah",
    from: "CAD",
    to: "USD",
    inputAmount: "150.00",
    feeCad: "2.00",
    purpose: "Personal travel",
    sourceOfFunds: "Savings",
  },
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:5`,
    customerSlug: "james-okonkwo",
    from: "EUR",
    to: "CAD",
    inputAmount: "200.00",
    feeCad: "3.00",
    purpose: "Living expenses",
    sourceOfFunds: "Employment income",
  },
  {
    key: `${DEMO_IDEMPOTENCY_PREFIX}tx:6`,
    customerSlug: "omar-haddad",
    from: "CAD",
    to: "EUR",
    inputAmount: "180.00",
    feeCad: "2.50",
    purpose: "Travel",
    sourceOfFunds: "Employment income",
  },
];

const OPENING_BALANCES = {
  CAD: "25000.00",
  USD: "12000.00",
  EUR: "7000.00",
  GBP: "3500.00",
} as const;

export function demoStaffRowId(tenantId: string = DEMO.tenantId): string {
  return `${tenantId}:${DEMO_STAFF_ID}`;
}

/** York FX is the only product-demo desk. siteSlug must still say yorkfx. */
export function isDemoDeskTenant(tenant: { id: string; siteSlug?: string | null }): boolean {
  return tenant.id === DEMO.tenantId && tenant.siteSlug === "yorkfx";
}

/**
 * DEMO_STAFF_BOOTSTRAP="demo:password". Any other staff id is refused so
 * this env cannot be pointed at a lived-in account. Password is not
 * returned in logs; callers must not print it.
 */
export function parseDemoStaffBootstrap(
  value: string | undefined,
): { staffId: string; password: string } | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const staffId = trimmed.slice(0, colon).trim();
  const password = trimmed.slice(colon + 1);
  if (staffId !== DEMO_STAFF_ID) return null;
  if (password.length < 8) return null;
  return { staffId, password };
}

export function shouldPopulateDemoDesk(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.DEMO_POPULATE?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export async function ensureDemoStaff(db: Db, password: string | null): Promise<DemoStaffResult> {
  const tenant = await db
    .select({ id: schema.tenants.id, siteSlug: schema.tenants.siteSlug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEMO.tenantId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!tenant) return "no-tenant";

  const id = demoStaffRowId();
  const existing = await db
    .select()
    .from(schema.staffUsers)
    .where(eq(schema.staffUsers.id, id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    const passwordHash = await hashPassword(password ?? randomBytes(32).toString("hex"));
    await db.insert(schema.staffUsers).values({
      id,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      staffId: DEMO_STAFF_ID,
      name: DEMO_STAFF_NAME,
      role: "teller",
      authorizedBranchIds: [DEMO.branchId],
      passwordHash,
      mustChangePassword: false,
      passwordUpdatedAt: password ? new Date() : null,
      active: true,
    });
    return "created";
  }

  if (password && existing.passwordUpdatedAt == null) {
    await db
      .update(schema.staffUsers)
      .set({
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        passwordUpdatedAt: new Date(),
        active: true,
      })
      .where(eq(schema.staffUsers.id, id));
    return "password_set";
  }

  return "exists";
}

function demoActor(role: LedgerActor["role"]): LedgerActor {
  return {
    userId: demoStaffRowId(),
    tenantId: DEMO.tenantId,
    legalEntityId: DEMO.legalEntityId,
    branchId: DEMO.branchId,
    workspaceId: DEMO.workspaceId,
    tillId: DEMO_TILL_ID,
    role,
    authorizedBranchIds: [DEMO.branchId],
  };
}

async function loadDemoTenant(db: Db) {
  return db
    .select({ id: schema.tenants.id, siteSlug: schema.tenants.siteSlug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEMO.tenantId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function alreadyPosted(pool: pg.Pool, actor: LedgerActor, idempotencyKey: string) {
  const found = await pool.query(
    `SELECT 1
       FROM ledger_idempotency
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        AND workspace_id=$4 AND till_id=$5
        AND operation='quote-post' AND idempotency_key=$6
        AND response IS NOT NULL`,
    [
      actor.tenantId,
      actor.legalEntityId,
      actor.branchId,
      actor.workspaceId,
      actor.tillId,
      idempotencyKey,
    ],
  );
  return (found.rowCount ?? 0) > 0;
}

async function ensureOpeningBalances(pool: pg.Pool, admin: LedgerActor) {
  const provisioning = new LedgerProvisioningService(pool);
  try {
    await provisioning.initializeBalances(admin, OPENING_BALANCES);
  } catch (error) {
    if (
      error instanceof LedgerError &&
      (error.code === "OPENING_BALANCES_ALREADY_SET" || error.code === "TILL_ALREADY_ACTIVE")
    ) {
      return;
    }
    throw error;
  }
}

async function ensureDemoRateBoard(db: Db, pool: pg.Pool) {
  const latest = await pool.query(
    `SELECT id, board_rows, published_at
       FROM rate_boards
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
      ORDER BY published_at DESC
      LIMIT 1`,
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
  );
  const maxAgeMs = boardMaxAgeSeconds() * 1000;
  if (latest.rowCount) {
    const row = latest.rows[0] as {
      id: string;
      board_rows: Record<string, { mid: number; show?: boolean }>;
      published_at: Date | string;
    };
    const rows = { ...row.board_rows };
    let changed = false;
    if (!rows.USD?.show) {
      rows.USD = { mid: 1.36407, show: true };
      changed = true;
    }
    if (!rows.EUR?.show) {
      rows.EUR = { mid: 1.47102, show: true };
      changed = true;
    }
    const publishedAt = new Date(row.published_at).getTime();
    const stale = !Number.isFinite(publishedAt) || Date.now() - publishedAt > maxAgeMs;
    if (changed || stale) {
      await pool.query(
        `UPDATE rate_boards
            SET board_rows=$2, published_at=now()
          WHERE id=$1 AND tenant_id=$3`,
        [row.id, JSON.stringify(rows), DEMO.tenantId],
      );
    }
    return;
  }

  const existing = await db
    .select({ id: schema.rateBoards.id })
    .from(schema.rateBoards)
    .where(
      and(
        eq(schema.rateBoards.tenantId, DEMO.tenantId),
        eq(schema.rateBoards.legalEntityId, DEMO.legalEntityId),
        eq(schema.rateBoards.branchId, DEMO.branchId),
      ),
    )
    .limit(1);
  if (existing.length) return;

  await db.insert(schema.rateBoards).values({
    id: "demo-desk-board-v1",
    tenantId: DEMO.tenantId,
    legalEntityId: DEMO.legalEntityId,
    branchId: DEMO.branchId,
    buyMargin: "0.015",
    sellMargin: "0.015",
    boardRows: {
      USD: { mid: 1.36407, show: true },
      EUR: { mid: 1.47102, show: true },
      GBP: { mid: 1.7304, show: true },
    },
    boardOrder: ["CAD", "USD", "EUR", "GBP"],
    publishedBy: "demo-desk",
  });
}

async function ensureDemoCustomers(pool: pg.Pool, actor: LedgerActor) {
  const clients = new ClientRecordService(pool);
  const bySlug = new Map<string, string>();
  for (const spec of DEMO_CUSTOMERS) {
    const found = await clients.lookupByName(actor, spec.name);
    const existingId = typeof found.clients[0]?.clientId === "string" ? found.clients[0].clientId : "";
    let clientId = existingId;
    if (!clientId) {
      const created = await clients.create(actor, {
        legalName: spec.name,
        kind: "individual",
        dateOfBirth: spec.dateOfBirth,
        city: spec.city,
        region: spec.region,
        postalCode: spec.postalCode,
        country: "CA",
        phone: spec.phone,
        occupation: spec.occupation,
        notes: "York FX product-demo file",
        riskRating: "normal",
        verificationStatus: "identified",
      });
      if (typeof created.clientId !== "string" || !created.clientId) {
        throw new LedgerError("CUSTOMER_NOT_FOUND", `Demo client ${spec.name} was not created.`);
      }
      clientId = created.clientId;
      await clients.addDocument(actor, clientId, {
        docType: "passport",
        docNumber: spec.docNumber,
        issuingJurisdiction: "CA",
        issuedOn: "2022-04-01",
        expiresOn: "2032-04-01",
        isPrimary: true,
      });
    } else if (!found.clients[0]?.documents?.length) {
      await clients.addDocument(actor, clientId, {
        docType: "passport",
        docNumber: spec.docNumber,
        issuingJurisdiction: "CA",
        issuedOn: "2022-04-01",
        expiresOn: "2032-04-01",
        isPrimary: true,
      });
    }
    const counter = await clients.counterRecord(actor, clientId);
    bySlug.set(spec.slug, counter.customerId);
  }
  return bySlug;
}

function dealDirection(from: string, to: string): "customer_buy_foreign" | "customer_sell_foreign" {
  if (from === "CAD") return "customer_buy_foreign";
  if (to === "CAD") return "customer_sell_foreign";
  throw new LedgerError("INVALID_REQUEST", "Demo deals are CAD↔foreign only.");
}

async function postDemoDeals(
  pool: pg.Pool,
  actor: LedgerActor,
  customerIds: Map<string, string>,
) {
  const quotes = new QuoteService(pool);
  let posted = 0;
  let reused = 0;
  for (const deal of DEMO_DEALS) {
    if (await alreadyPosted(pool, actor, deal.key)) {
      reused += 1;
      continue;
    }
    const customerId = customerIds.get(deal.customerSlug);
    if (!customerId) {
      throw new LedgerError("CUSTOMER_NOT_FOUND", `Demo customer ${deal.customerSlug} is missing.`);
    }
    const quote = await quotes.create(actor, {
      customerId,
      from: deal.from,
      to: deal.to,
      inputAmount: deal.inputAmount,
      feeCad: deal.feeCad,
      direction: dealDirection(deal.from, deal.to),
    });
    await quotes.post(actor, quote.quoteId, deal.key, deal.purpose, deal.sourceOfFunds);
    posted += 1;
  }
  return { posted, reused };
}

/**
 * Post the York FX product-demo book through the real services.
 * Safe to call repeatedly. Never writes outside tnt-yorkfx.
 */
export async function populateDemoDesk(pool: pg.Pool, db: Db): Promise<DemoPopulateResult> {
  const tenant = await loadDemoTenant(db);
  if (!tenant || !isDemoDeskTenant(tenant)) {
    return {
      status: "skipped",
      reason: "not-demo-tenant",
      customers: 0,
      transactions: 0,
      posted: 0,
      reused: 0,
      tillOpen: false,
    };
  }

  const staff = await ensureDemoStaff(db, null);
  if (staff === "no-tenant") {
    return {
      status: "skipped",
      reason: "no-tenant",
      customers: 0,
      transactions: 0,
      posted: 0,
      reused: 0,
      tillOpen: false,
    };
  }

  const teller = demoActor("teller");
  const admin = demoActor("administrator");
  await ensureLedgerPrincipal(pool, admin);
  await ensureOpeningBalances(pool, admin);
  await ensureLedgerPrincipal(pool, teller);

  await ensureDemoRateBoard(db, pool);

  const tills = new TillControlService(pool);
  const session = await tills.open(teller);
  const tillOpen = session.session?.status === "open";

  const customerIds = await ensureDemoCustomers(pool, teller);
  const { posted, reused } = await postDemoDeals(pool, teller, customerIds);

  const listed = await new LedgerProvisioningService(pool).listTransactions(teller, 50);
  return {
    status: posted > 0 ? "populated" : "already",
    customers: customerIds.size,
    transactions: listed.transactions.length,
    posted,
    reused,
    tillOpen,
  };
}
