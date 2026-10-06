/* The screen's session, then the ledger.

   Signup refuses a listed country before a desk exists. A desk that
   does open cannot post a transfer to a listed corridor, and cannot
   post a deal for a client in a listed country. The transfer form's
   corridor picker does not list those countries. This drives the
   posts the screen's session is allowed to make, then reads the book.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, codeFor, logSize } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { n: number }[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now().toString(36);
const EMAIL = `owner-${stamp}@sanction-seam.example`;
const BLOCKED_EMAIL = `iran-${stamp}@sanction-seam.example`;
const SLUG = `sseam${stamp}`;
const SHOP = `Sanction Seam ${stamp}`;

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.end();
});

test("a listed country cannot open a desk, and a listed client or corridor cannot post", async ({ page }) => {
  /* The invite is still the door. A listed country is refused after
     that, which is the person this block is for. */
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, 'Blocked', 'invited'),
            ($4, $5, 'early_access', $6, 'Seam Owner', 'invited')`,
    [
      `enq-blk-${stamp}`,
      `BLK${stamp}`.toUpperCase(),
      BLOCKED_EMAIL,
      `enq-ok-${stamp}`,
      `SOK${stamp}`.toUpperCase(),
      EMAIL,
    ],
  );

  const blocked = await page.request.post("/api/signup", {
    data: {
      businessName: "Blocked Desk",
      ownerName: "Owner",
      email: BLOCKED_EMAIL,
      password: "sanction-seam-2026",
      slug: `sblk${stamp}`,
      onboarding: { country: "Iran" },
    },
  });
  expect(blocked.status(), await blocked.text()).toBe(403);
  const blockedBody = await blocked.json();
  expect(blockedBody.error).toBe("sanctioned_country");
  expect(blockedBody.detail).toContain("cannot be opened");
  expect(blockedBody.detail).not.toMatch(/\u2014|\u2013/);

  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Seam Owner",
      email: EMAIL,
      password: "sanction-seam-2026",
      slug: SLUG,
      onboarding: { country: "XX", homeCurrency: "USD", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const client = await page.request.post("/api/clients", {
    data: { legalName: "Iran Client", country: "Iran" },
  });
  expect(client.status(), await client.text()).toBe(201);
  const clientId = (await client.json()).clientId as string;
  const counter = await page.request.post(`/api/clients/${clientId}/counter-record`);
  expect(counter.status(), await counter.text()).toBe(200);
  const customerId = (await counter.json()).customerId as string;

  const opened = await page.request.post("/api/ledger/till-sessions/open", { data: {} });
  /* Landing on the desk may already have opened the till. */
  expect([201, 409], await opened.text()).toContain(opened.status());

  const send = await page.request.post("/api/ledger/remittances/send", {
    data: {
      idempotencyKey: `seam-deal-${stamp}`,
      customerId,
      reference: `seam-deal-${stamp}`,
      principalAmount: "10.00",
      feeAmount: "0.00",
      payoutCurrency: "EUR",
      payoutAmount: "1.00",
      corridor: "DE",
      partner: "Corridor partner",
      beneficiaryName: "Ann Beneficiary",
      purpose: "Family support",
      sourceOfFunds: "Salary",
    },
  });
  expect(send.status(), await send.text()).toBe(422);
  const deal = await send.json();
  expect(deal.code).toBe("SANCTIONS-STOP");
  expect(deal.message).toContain("stopped");
  expect(deal.message).not.toMatch(/\u2014|\u2013/);

  const clean = await page.request.post("/api/clients", { data: { legalName: "Clean Client" } });
  const cleanBody = await clean.json();
  expect(clean.status(), JSON.stringify(cleanBody)).toBe(201);
  const cleanCounter = await page.request.post(`/api/clients/${cleanBody.clientId}/counter-record`);
  const cleanCounterBody = await cleanCounter.json();
  expect(cleanCounter.status(), JSON.stringify(cleanCounterBody)).toBe(200);
  const cleanId = cleanCounterBody.customerId as string;
  const corridor = await page.request.post("/api/ledger/remittances/send", {
    data: {
      idempotencyKey: `seam-kp-${stamp}`,
      customerId: cleanId,
      reference: `seam-kp-${stamp}`,
      principalAmount: "10.00",
      feeAmount: "0.00",
      payoutCurrency: "EUR",
      payoutAmount: "1.00",
      corridor: "KP",
      partner: "Corridor partner",
      beneficiaryName: "Ann Beneficiary",
      purpose: "Family support",
      sourceOfFunds: "Salary",
    },
  });
  expect(corridor.status(), await corridor.text()).toBe(422);
  const corridorBody = await corridor.json();
  expect(corridorBody.code).toBe("SANCTIONED_JURISDICTION");
  expect(corridorBody.message).toContain("North Korea");

  const booked = await pool.query(
    "SELECT count(*)::int AS n FROM ledger_transactions WHERE tenant_id=$1 AND customer_id=$2",
    [`tnt-${SLUG}`, customerId],
  );
  expect(booked.rows[0].n).toBe(0);
});
