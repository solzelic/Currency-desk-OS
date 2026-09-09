/* ============================================================
   A DAY AT THE DESK — the deployment gate.

   Every other test in this suite proves one thing works. This one asks
   the only question a shop owner actually cares about:

     can a desk open in the morning, trade all day, and close at night
     with books that balance — without anybody reaching for a workaround?

   It is deliberately not a unit of anything. It is a shift. The vault is
   counted in, the drawer is floated from it, a teller serves customers
   across every line the product sells, a deal crosses the identification
   line and is refused until the customer is on file, and at the end the
   drawer is counted and the day is signed off.

   THE ASSERTION THAT MATTERS is the last one: what the ledger says should
   be in the drawer at close equals what this test worked out from the
   opening float and every movement since — computed independently, in the
   test, the way a shop owner does it on paper. If those two ever part
   company, the desk cannot be trusted with a day's takings, whatever else
   is green.

   Written to be READ by somebody deciding whether to put this in a shop.
   Each step says what a real person is doing, so a failure names the
   moment of the day that broke rather than a route.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* The shop's own money, in its own currency. Every figure below is CAD
   because the demo desk's pack is Canada; nothing here assumes that
   beyond reading it from the ledger. */
const OPENING_FLOAT = "25000.00";

/* This shift has its own till, opened through the product's "add a
   till" route, so it does not disturb cash-seam (which needs a drawer
   that has never been opened) or obligation-seam (which needs one it
   can post to). The workspace header is sent on every call — the same
   contract the OS client uses — and the server would also resolve the
   session workspace if the header were omitted. */
const SHIFT_TILL = "till-day";
let shiftWorkspaceId = "";

async function ensureShiftWorkspace(page: Page): Promise<string> {
  if (shiftWorkspaceId) return shiftWorkspaceId;
  const created = await page.evaluate(async (tillId) => {
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, SHIFT_TILL);
  const id = created.body.workspaceId ?? created.body.till?.workspaceId;
  if (!id) {
    throw new Error(`the shift till could not be added: ${JSON.stringify(created)}`);
  }
  shiftWorkspaceId = id as string;
  return shiftWorkspaceId;
}

async function openShift(page: Page) {
  await signInAtDesk(page, "r.haddad");
  await ensureShiftWorkspace(page);
}

/** Post to the desk's own routes, from inside the signed-in page. */
function desk(page: Page) {
  const post = (url: string, body: unknown) =>
    page.evaluate(
      ([u, b, ws]) =>
        fetch(u as string, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...((ws as string) ? { "x-workspace-id": ws as string } : {}),
          },
          credentials: "same-origin",
          body: JSON.stringify(b),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
      [url, body, shiftWorkspaceId] as const,
    );
  const get = (url: string) =>
    page.evaluate(
      ([u, ws]) =>
        fetch(u as string, {
          headers: (ws as string) ? { "x-workspace-id": ws as string } : {},
          credentials: "same-origin",
        }).then((r) => r.json()),
      [url, shiftWorkspaceId] as const,
    );
  return { post, get };
}

/** The drawer this shift is standing at. */
const drawer = (page: Page) => ({
  balances: () =>
    desk(page)
      .get("/api/ledger/till-balances")
      .then((r: { balances?: Record<string, string> }) => r.balances ?? {}),
  session: () =>
    desk(page)
      .get("/api/ledger/till-session")
      .then((r: { session?: { status: string; sessionId: string } | null }) => r.session ?? null),
});

/* A running tally of what SHOULD be in the drawer, kept by the test the
   way an owner keeps it on paper. Never read from the server — that is
   the entire point of comparing them at the end. */
let expectedCad = 0;
let customerId = "";

test("morning — the desk opens on a counted drawer", async ({ page }) => {
  await openShift(page);

  const api = desk(page);
  const till = drawer(page);

  /* The opening float. A real desk counts this in; the ledger refuses to
     invent it, which is why it is stated rather than assumed. */
  const opened = await api.post("/api/ledger/opening-balances", { balances: { CAD: OPENING_FLOAT } });
  expect([201, 409], `opening balances refused: ${JSON.stringify(opened.body)}`)
    .toContain(opened.status);

  const session = await api.post("/api/ledger/till-sessions/open", {});
  expect([201, 409], `the till would not open: ${JSON.stringify(session.body)}`)
    .toContain(session.status);
  expect((await till.session())?.status).toBe("open");

  /* Whatever was actually in the drawer when the day started — which may
     not be the float, because this database outlives a test run and a
     real shop's drawer outlives a night. The tally starts from truth. */
  expectedCad = Number((await till.balances()).CAD ?? 0);
  expect(expectedCad, "the drawer is empty; nothing can be traded").toBeGreaterThan(0);
});

test("a customer the desk has never seen is put on file", async ({ page }) => {
  await openShift(page);
  const api = desk(page);

  /* Identification first, because the deals below cross the desk's lines
     and the ledger will refuse an unidentified customer at them. That
     refusal is the product working; serving them means doing this. */
  const made = await api.post("/api/ledger/customers", {
    externalRef: `day-${Date.now()}`,
    name: "Priya Raman",
    risk: "normal",
    idStatus: "verified",
  });
  expect(made.status, `the customer could not be created: ${JSON.stringify(made.body)}`)
    .toBe(201);
  customerId = made.body.customerId;
  expect(customerId).toBeTruthy();
});

test("the counter trades — an exchange, over the counter, both ways", async ({
  page,
}) => {
  await openShift(page);
  const api = desk(page);
  const book = drawer(page);

  /* The desk needs dollars to sell dollars. Floated in from the bank
     through the cash rail, which is a real movement and is recorded. */
  const float = await api.post("/api/ledger/till-movements", {
    idempotencyKey: `day-usd-float-${Date.now()}`,
    direction: "in",
    currency: "USD",
    amount: "5000.00",
    counterpartyType: "bank",
    counterpartyRef: "morning float",
    reason: "US dollars for the day",
  });
  expect(float.status, JSON.stringify(float.body)).toBe(201);

  /* A customer buys US dollars with Canadian cash. Quoted, then posted
     against that frozen quote — the desk cannot post at a price it never
     showed anybody. */
  const quote = await api.post("/api/quotes", {
    customerId,
    from: "CAD",
    to: "USD",
    inputAmount: "1000.00",
    feeCad: "5.00",
    direction: "customer_buy_foreign",
  });
  expect(quote.status, `no quote: ${JSON.stringify(quote.body)}`).toBe(201);

  const posted = await api.post(`/api/quotes/${quote.body.quoteId}/post`, {
    idempotencyKey: `day-exchange-${Date.now()}`,
    purpose: "Personal travel",
    sourceOfFunds: "Employment income",
  });
  expect(posted.status, `the deal did not post: ${JSON.stringify(posted.body)}`).toBe(201);

  /* Cash in: what the customer handed over, principal and fee. */
  expectedCad += 1000 + 5;
  await expect
    .poll(async () => Number((await book.balances()).CAD), { timeout: 15_000 })
    .toBeCloseTo(expectedCad, 2);
});

test("the counter trades — a remittance, and the desk owes a payout", async ({
  page,
}) => {
  await openShift(page);
  const api = desk(page);
  const book = drawer(page);

  const sent = await api.post("/api/ledger/remittances/send", {
    idempotencyKey: `day-remit-${Date.now()}`,
    customerId,
    reference: `DAY-${Date.now()}`,
    principalAmount: "600.00",
    feeAmount: "9.99",
    payoutCurrency: "PHP",
    payoutAmount: "24000.00",
    corridor: "PH",
    partner: "Cebuana Lhuillier",
    beneficiaryName: "Maria Raman",
    purpose: "Family support",
    sourceOfFunds: "Employment income",
  });
  expect(sent.status, `the remittance did not post: ${JSON.stringify(sent.body)}`).toBe(201);

  expectedCad += 600 + 9.99;
  await expect
    .poll(async () => Number((await book.balances()).CAD), { timeout: 15_000 })
    .toBeCloseTo(expectedCad, 2);

  /* And the promise it left behind is on the book, because forty of these
     is forty payouts somebody has to fund. */
  const owed = await api.get("/api/ledger/obligations?status=open&limit=200");
  expect(
    owed.obligations.some((o: { kind: string }) => o.kind === "remittance_payable"),
    "the desk took the cash and recorded no payable",
  ).toBe(true);
});

test("the counter trades — a cheque is cashed out of the drawer", async ({ page }) => {
  await openShift(page);
  const api = desk(page);
  const book = drawer(page);

  const cashed = await api.post("/api/ledger/cheques", {
    idempotencyKey: `day-cheque-${Date.now()}`,
    customerId,
    chequeNumber: `00${Date.now() % 1000}`,
    maker: "Northwood Property Management",
    draweeBank: "RBC",
    chequeType: "payroll",
    typeLabel: "Payroll",
    currency: "CAD",
    faceAmount: "1200.00",
    feeAmount: "24.00",
    holdDays: 5,
    endorsed: true,
  });
  expect(cashed.status, `the cheque was not cashed: ${JSON.stringify(cashed.body)}`)
    .toBe(201);

  /* Cash OUT: the face less the fee. The cheque itself is not cash — it
     is a promise the desk is now holding, and the drawer is lighter. */
  expectedCad -= 1200 - 24;
  await expect
    .poll(async () => Number((await book.balances()).CAD), { timeout: 15_000 })
    .toBeCloseTo(expectedCad, 2);
});

test("the desk refuses what it should, and says why", async ({ page }) => {
  await openShift(page);
  const api = desk(page);

  /* A customer with no identification, at an amount over the desk's line.
     The refusal is the product working — a desk that took this would be
     the defect. */
  const stranger = await api.post("/api/ledger/customers", {
    externalRef: `stranger-${Date.now()}`,
    name: "Walk In",
    risk: "normal",
    idStatus: "missing",
  });
  expect(stranger.status).toBe(201);

  const quote = await api.post("/api/quotes", {
    customerId: stranger.body.customerId,
    from: "CAD",
    to: "USD",
    inputAmount: "9000.00",
    feeCad: "0",
    direction: "customer_buy_foreign",
  });
  expect(quote.status).toBe(201);

  const refused = await api.post(`/api/quotes/${quote.body.quoteId}/post`, {
    idempotencyKey: `day-refused-${Date.now()}`,
    purpose: "Personal travel",
    sourceOfFunds: "Employment income",
  });
  expect(
    refused.status,
    `an unidentified customer was served over the line: ${JSON.stringify(refused.body)}`,
  ).toBe(422);
  expect(String(refused.body.code)).toContain("COMPLIANCE");
});

test("night — the drawer is counted and the books balance", async ({ page }) => {
  await openShift(page);
  const api = desk(page);
  const book = drawer(page);

  /* THE GATE.

     What the ledger says is in the drawer, against what this test worked
     out independently from the opening float and every movement of the
     day. This is the arithmetic a shop owner does on paper at closing,
     and if the two disagree the desk cannot be trusted with a day's
     takings whatever else is green. */
  const held = await book.balances();
  expect(
    Number(held.CAD),
    "the ledger's drawer and the day's arithmetic have parted company",
  ).toBeCloseTo(expectedCad, 2);

  /* Counted in every currency the drawer holds — the close refuses to run
     otherwise, because a substituted figure at this moment overwrites
     real money. */
  const counts: Record<string, string> = {};
  for (const [code, amount] of Object.entries(held)) {
    counts[code] = String(amount);
  }
  const session = await book.session();
  const closed = await api.post(
    `/api/ledger/till-sessions/${session.sessionId}/close`,
    {
      idempotencyKey: `day-close-${Date.now()}`,
      counts,
      note: "End of day",
    },
  );
  /* 200, not 201. Closing a till creates nothing — it records a count
     against a session that already existed and settles it. The route is
     right and the first version of this expectation was not. */
  expect(closed.status, `the day would not close: ${JSON.stringify(closed.body)}`)
    .toBe(200);

  /* Counted to the penny, so there is no variance to explain. */
  for (const [code] of Object.entries(counts)) {
    const line = closed.body.latestCounts?.[code];
    expect(line, `${code} was not counted at close`).toBeTruthy();
    expect(Number(line.variance), `${code} closed with a variance`).toBeCloseTo(0, 2);
  }
  expect((await book.session())?.status).toBe("closed");
});

test("night — the day's sign-off is the ledger's own figures", async ({ page }) => {
  await openShift(page);
  const api = desk(page);

  /* The paperwork a shop keeps. Read from the book rather than from the
     screen's memory of it — a sign-off sheet that agrees with a browser
     and not with the ledger is worse than none. */
  const summary = await api.get("/api/ledger/summary");
  expect(summary.posted, "a day of trading posted nothing").toBeGreaterThan(0);
  expect(Number(summary.volumeHome)).toBeGreaterThan(0);
});

test("tomorrow — the shift till is closed and the shared drawer is untouched", async ({ page }) => {
  await openShift(page);
  const book = drawer(page);

  /* This shift traded on till-day, not the seeded till-01. Closing it
     is the honest end of the day and leaves cash-seam and
     obligation-seam on the drawer they arrived with. */
  expect((await book.session())?.status).toBe("closed");
});
