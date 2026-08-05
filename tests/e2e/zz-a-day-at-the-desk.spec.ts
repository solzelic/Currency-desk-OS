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

/* ---- WHY THIS FILE IS NAMED TO RUN LAST ----

   It trades a whole shift on the demo desk's till, which conflicts with
   two suites in opposite directions: cash-seam tests a brand-new desk's
   FIRST EVER morning and needs a till with no session on it, while
   obligation-seam needs one it can post to. A day that ends closed
   breaks the second; a day that ends open breaks the first. There is no
   state to leave behind that satisfies both.

   Two fixes were tried before this one, and it is worth knowing why they
   were abandoned. Restoring the session to however it was found does not
   help, because cash-seam needs a till that was never opened AT ALL and
   opening one is the whole point of this file. Giving the shift its own
   till through the product's own "add a till" route made things
   dramatically worse — ten failures — because several routes resolve a
   request's till as "the only workspace at this branch", so a third
   workspace denies every caller that does not send a header.

   That fallback is the real defect and it is tracked (#33 in
   docs/ROAD_TO_DEPLOYMENT.md). Until it is fixed, this file runs after
   the suites it would otherwise disturb, which the runner orders by
   path. That is a WORKAROUND and is named as one — the moment a session
   resolves to a teller's own till rather than to whichever one is
   unique, this comment and this filename should both go. */

/** Post to the desk's own routes, from inside the signed-in page. */
function desk(page: Page) {
  const post = (url: string, body: unknown) =>
    page.evaluate(
      ([u, b]) =>
        fetch(u as string, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(b),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
      [url, body] as const,
    );
  const get = (url: string) =>
    page.evaluate((u) => fetch(u).then((r) => r.json()), url);
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
/* Whether the desk was trading when this file arrived. Restored at the
   end, because the suites either side of this one want OPPOSITE states —
   cash-seam needs a till it can open, obligation-seam needs one it can
   post to — and a day that ends by imposing either of them breaks the
   other. Leaving things as found is the only answer that works for both.
   See docs/ROAD_TO_DEPLOYMENT.md on why order-dependence is tracked
   work rather than a quirk. */
let wasOpenOnArrival = false;

test("morning — the desk opens on a counted drawer", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");

  const api = desk(page);
  const till = drawer(page);

  /* The opening float. A real desk counts this in; the ledger refuses to
     invent it, which is why it is stated rather than assumed. */
  const opened = await api.post("/api/ledger/opening-balances", { balances: { CAD: OPENING_FLOAT } });
  expect([201, 409], `opening balances refused: ${JSON.stringify(opened.body)}`)
    .toContain(opened.status);

  wasOpenOnArrival = (await till.session())?.status === "open";
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
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
  await signInAtDesk(page, "r.haddad");
  const api = desk(page);

  /* The paperwork a shop keeps. Read from the book rather than from the
     screen's memory of it — a sign-off sheet that agrees with a browser
     and not with the ledger is worse than none. */
  const summary = await api.get("/api/ledger/summary");
  expect(summary.posted, "a day of trading posted nothing").toBeGreaterThan(0);
  expect(Number(summary.volumeHome)).toBeGreaterThan(0);
});

test("tomorrow — the desk is left ready to open again", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const api = desk(page);
  const book = drawer(page);

  /* A closed till is the correct end of a day and the wrong thing to
     leave behind: the seam tests that follow this one need a desk that
     can trade, and a suite whose result depends on which file ran first
     is a suite that cannot be trusted. Opening tomorrow's session is
     both the cleanup and the honest next step of the story.

     Stated as its own step rather than hidden in a hook, because leaving
     shared state behind is the single most common way tests in this
     repository have lied — see docs/ROAD_TO_DEPLOYMENT.md. */
  if (!wasOpenOnArrival) {
    /* Found closed, left closed. */
    expect((await book.session())?.status).toBe("closed");
    return;
  }
  const tomorrow = await api.post("/api/ledger/till-sessions/open", {});
  expect([201, 409], `tomorrow would not open: ${JSON.stringify(tomorrow.body)}`)
    .toContain(tomorrow.status);
  expect((await book.session())?.status).toBe("open");
});
