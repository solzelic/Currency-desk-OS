/* The real invite, then the desk.

   A listed country is refused while the applicant is still in
   onboarding, through the same launch the page uses. It is not
   refused by posting to /api/signup. After a clean launch, the
   signed-in session cannot post a deal for a client whose country
   is the ISO code the client picker stores, and cannot send to a
   listed corridor. The stop is on the audit log as well as on the
   screen, because the deal itself rolls back.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, codeFor, logSize, rendered } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now().toString(36);
const EMAIL = `owner-${stamp}@sanction-seam.example`;
const REF = `SOK${stamp}`.toUpperCase();
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

test("invite, refuse a listed country, launch, and stop the deal", async ({ page }) => {
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, 'Seam Owner', 'invited')`,
    [`enq-ok-${stamp}`, REF, EMAIL],
  );

  await page.goto(`/onboarding/${REF}`);
  await rendered(page, /Let.s open your desk/i);

  const blocked = await page.request.put(`/api/onboarding/${REF}/state`, {
    data: { at: 1, data: { country: "Iran" } },
  });
  expect(blocked.status(), await blocked.text()).toBe(403);
  const blockedBody = await blocked.json();
  expect(blockedBody.error).toBe("sanctioned_country");
  expect(blockedBody.detail).toContain("cannot set its country");
  expect(blockedBody.detail).not.toMatch(/\u2014|\u2013/);

  const saved = await page.request.put(`/api/onboarding/${REF}/state`, {
    data: {
      at: 4,
      data: {
        country: "XX",
        elseCountry: "Germany",
        operatingName: SHOP,
        bizName: `${SHOP} Inc.`,
        ownerName: "Seam Owner",
        ownerEmail: EMAIL,
        plan: "full",
        city: "Berlin",
      },
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  const before = logSize();
  const sent = await page.request.post(`/api/onboarding/${REF}/verify/send`, { data: { data: {} } });
  expect(sent.status(), await sent.text()).toBe(200);
  const code = await codeFor(EMAIL, before);
  expect((await page.request.post(`/api/onboarding/${REF}/verify/check`, { data: { code } })).status()).toBe(200);

  const refusedLaunch = await page.request.post(`/api/onboarding/${REF}/launch`, {
    data: { data: { country: "KP", ownerPass: "sanction-seam-2026" } },
  });
  expect(refusedLaunch.status(), await refusedLaunch.text()).toBe(403);
  const refusedBody = await refusedLaunch.json();
  expect(refusedBody.error).toBe("sanctioned_country");
  expect(refusedBody.detail).toContain("cannot be opened");
  expect(refusedBody.detail).not.toMatch(/\u2014|\u2013/);

  const launched = await page.request.post(`/api/onboarding/${REF}/launch`, {
    data: { data: { ownerPass: "sanction-seam-2026" } },
  });
  expect(launched.status(), await launched.text()).toBe(201);
  const launchBody = await launched.json();
  expect(launchBody.signedIn).toBe(true);
  const tenantId = launchBody.tenantId as string;

  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  /* IR is the code the client country picker stores for Iran. */
  const client = await page.request.post("/api/clients", {
    data: { legalName: "Iran Client", country: "IR" },
  });
  expect(client.status(), await client.text()).toBe(201);
  const clientId = (await client.json()).clientId as string;
  const counter = await page.request.post(`/api/clients/${clientId}/counter-record`);
  expect(counter.status(), await counter.text()).toBe(200);
  const customerId = (await counter.json()).customerId as string;

  const opened = await page.request.post("/api/ledger/till-sessions/open", { data: {} });
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
  const corridor = await page.request.post("/api/ledger/remittances/send", {
    data: {
      idempotencyKey: `seam-kp-${stamp}`,
      customerId: cleanCounterBody.customerId,
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
    [tenantId, customerId],
  );
  expect(Number(booked.rows[0].n)).toBe(0);
  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE tenant_id=$1 AND action='sanctions.stop'`,
    [tenantId],
  );
  expect(Number(audit.rows[0].n)).toBeGreaterThan(0);
});
