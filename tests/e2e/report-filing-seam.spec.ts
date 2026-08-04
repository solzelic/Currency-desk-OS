/* ============================================================
   Filing a report on the screen, and asking the ledger whether it happened.

   Every defect this file exists for survived a fully green test run. The
   server suite tested a `ledger_report_filings` table nothing wrote to; the
   browser suite tested a Compliance screen that wrote to localStorage; the
   two never met, so nobody noticed that the product's five-year regulatory
   record was a browser artefact. An exploratory pass filed three reports
   through this exact screen and then counted the rows: zero.

   So this walk does the thing on the screen and then asks the ledger.

     · a report sealed at the counter is a row, with its payload
     · the sealed copy is read back from the ledger, not from the browser
     · a filed aggregate that takes on a later deal stops claiming to be
       filed, says which deals the earlier acknowledgement covered, and
       does not touch the sealed copy of what was already sent
     · the correction is a SECOND filing, linked, and the first survives
       it word for word
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

type Page = import("@playwright/test").Page;

/** What the ledger holds, asked from inside the signed-in page. */
function filings(page: Page) {
  return {
    all: () =>
      page.evaluate(() =>
        fetch("/api/ledger/report-filings").then((r) => r.json()),
      ) as Promise<{ filings: any[] }>,
    copy: (id: string) =>
      page.evaluate(
        (filingId) =>
          fetch(`/api/ledger/report-filings/${filingId}`).then((r) => r.json()),
        id,
      ) as Promise<any>,
  };
}

/* The four sub-threshold remittances the seeded book sends to one
   beneficiary on one day — three different senders, none of them near the
   line, and a beneficiary who collects $13,200. It is the case the whole
   aggregation engine exists for, so it is the one worth filing here. */
const BENEFICIARY = "M. Carter · Cebu";
const SEEDED_REFS = ["LT-260618-002", "LT-260618-008", "LT-260618-009", "LT-260618-010"];

async function openCompliance(page: Page) {
  await page.getByText(/^Compliance$/).first().click();
  await rendered(page, /Sanctions & watchlist screening/i);
}

const tab = (page: Page, name: RegExp) =>
  page.locator("button.fld-tab").filter({ hasText: name }).first();

/* The aggregation card for one subject. Anchored on the card's own title
   rather than on its text, because the subject's name also appears on the
   row inside it that holds the File button — and filtering by text lands
   on whichever of the two nests deepest. */
const card = (page: Page, subject: string) =>
  page
    .locator('div[title="Open these records in the Ledger"]')
    .filter({ hasText: subject })
    .first();

/* Fill every blank the worksheet is holding open and seal it.

   Deliberately indiscriminate: the point of this walk is the seam, not
   which particular fields the Canadian form leaves to the counter, and a
   test that hardcodes that list is a test that breaks the day the form is
   transcribed properly from the pack. */
async function completeAndSeal(page: Page, acknowledgement: string) {
  const worksheet = page.locator('div[style*="max-width: 760px"]').first();
  await expect(worksheet.getByText(/FILING WORKSHEET/)).toBeVisible({ timeout: 20_000 });
  const inputs = worksheet.locator("input");
  for (let i = 0; i < (await inputs.count()); i++) {
    const box = inputs.nth(i);
    if (((await box.inputValue()) || "").trim() === "") await box.fill("N/A");
  }
  await worksheet.getByRole("button", { name: /Mark filed & seal/i }).click();
  await worksheet.locator('input[placeholder*="FWR receipt"]').fill(acknowledgement);
  await worksheet.getByRole("button", { name: /^Seal filed copy$/i }).click();
  await expect(worksheet.getByText(/FILING WORKSHEET/)).toHaveCount(0, { timeout: 20_000 });
}

test("a report sealed at the counter is a row on the ledger", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const book = filings(page);
  expect((await book.all()).filings).toHaveLength(0);

  await openCompliance(page);
  await tab(page, /aggregation/i).click();
  await rendered(page, /The 24-hour rule, handled for you/i);

  // the beneficiary-axis aggregate: three senders, one recipient, $13,200
  await expect(page.getByText(BENEFICIARY).first()).toBeVisible();
  await card(page, BENEFICIARY).getByRole("button", { name: /^File LCTR/ }).click();
  await completeAndSeal(page, "FWR-SEAM-0001");

  /* THE ASSERTION THIS FILE EXISTS FOR. Not "the screen says sealed" —
     the ledger, which is where a five-year record has to be. */
  const held = (await book.all()).filings;
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({
    reportCode: "LCTR",
    status: "filed",
    acknowledgementRef: "FWR-SEAM-0001",
    subjectName: BENEFICIARY,
    aggregationBasis: "beneficiary",
    packId: "pack-ca-v1",
    reportId: "rpt-ca-lctr",
  });
  /* And it names the deals it covers, which is what stops a later one
     being absorbed: the obligation's identity is its transaction set, and
     the group it belongs to is only who and when. */
  expect([...held[0].transactionRefs].sort()).toEqual([...SEEDED_REFS].sort());
  expect(held[0].obligationGroupId).toMatch(/^AGG-LCTR-B-/);
  expect(held[0].obligationId.startsWith(held[0].obligationGroupId)).toBe(true);
  expect(held[0].obligationId).not.toBe(held[0].obligationGroupId);

  // every field as submitted came with it
  const copy = await book.copy(held[0].filingId);
  expect(copy.payload.filing.reportRef).toBe(held[0].reportRef);
  expect(copy.payload.filing.map.length).toBeGreaterThan(0);
});

test("the sealed copy is read back from the ledger, not from this browser", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const held = (await filings(page).all()).filings;
  expect(held).toHaveLength(1);

  await openCompliance(page);
  await tab(page, /Filings/i).click();
  await rendered(page, /Filed copies are held on the ledger/i);

  /* Opening the filed copy has to reach the record. A screen that renders
     its own cached snapshot looks identical and is exactly the thing that
     could not survive a cleared browser or a second till. */
  const fetched = page.waitForRequest((r) =>
    r.url().includes(`/api/ledger/report-filings/${held[0].filingId}`),
  );
  const popup = page.waitForEvent("popup").catch(() => null);
  await page.getByRole("button", { name: /Sealed PDF/i }).first().click();
  await fetched;
  const opened = await popup;
  if (opened) await opened.close();
});

test("a filed aggregate that takes on a later deal reopens, and the sealed original survives the correction", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  const book = filings(page);
  const first = (await book.all()).filings[0];

  /* A fifth remittance to the same beneficiary, on the same day, after the
     report went in. Written into the desk's own book the way the desk
     stores it — `cdos_rows_v1` is one key holding every transaction, and
     is how a deal taken at the other till arrives here.

     Waited for first: the OS restores its saved state a beat after the page
     comes up, and writing the book before it has been restored replaces it
     with a one-row book instead of adding to it. */
  await expect
    .poll(
      () =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem("cdos_rows_v1") || "[]").length,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(5);
  await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem("cdos_rows_v1") || "[]");
    if (rows.some((r: any) => r.ref === "LT-260618-099")) return;
    rows.unshift({
      id: 99001, ref: "LT-260618-099", date: "2026-06-18", time: "16:40",
      customer: "Priya Nair", beneficiary: "M. Carter · Cebu",
      type: "Remittance — Send", inCcy: "CAD", inAmt: 2500, rate: 1,
      outCcy: "PHP", outAmt: 100000, fee: 9.99, teller: "R. Haddad",
      notes: "", status: "posted", thread: [], filed: false, filedInfo: null,
      ackStr: false, ackStrInfo: null, createdBy: "R. Haddad",
      createdAt: "2026-06-18 16:40",
    });
    localStorage.setItem("cdos_rows_v1", JSON.stringify(rows));
  });
  await page.reload();

  await openCompliance(page);
  await tab(page, /aggregation/i).click();
  await rendered(page, /The 24-hour rule, handled for you/i);

  const beneficiaryCard = card(page, BENEFICIARY);
  /* What the desk used to say here: "5 cash-ins · $15,700 · ✓ filed
     FWR-SEAM-0001" — reportable cash presented as filed under an
     acknowledgement that never covered it, with no File button and no
     warning. It has to say the opposite of that now. */
  await expect(beneficiaryCard).toContainText(/5 cash-ins/);
  await expect(beneficiaryCard).not.toContainText(/✓ filed/);
  await expect(beneficiaryCard).toContainText(/4 of these 5/);
  await expect(beneficiaryCard).toContainText(/FWR-SEAM-0001/);

  // and it is an open obligation again, on the page that lists them
  await tab(page, /Filings/i).click();
  await expect(
    page.getByText(/4 of these 5 were already filed under FWR-SEAM-0001/),
  ).toBeVisible();

  // nothing was quietly written while all that was worked out
  expect((await book.all()).filings).toHaveLength(1);

  // now file the correction the screen is asking for
  await tab(page, /aggregation/i).click();
  await card(page, BENEFICIARY).getByRole("button", { name: /^File amended LCTR/ }).click();
  await completeAndSeal(page, "FWR-SEAM-0002");

  const held = (await book.all()).filings;
  expect(held).toHaveLength(2);
  const correction = held.find((f) => f.acknowledgementRef === "FWR-SEAM-0002");
  const original = held.find((f) => f.filingId === first.filingId);

  /* Two submissions to the regulator, two acknowledgement numbers, two
     records — where the old design left one and deleted the sealed copy of
     the report that had actually gone in first. */
  expect(correction.amendsFilingId).toBe(first.filingId);
  expect(correction.transactionRefs).toHaveLength(5);
  expect(original.acknowledgementRef).toBe("FWR-SEAM-0001");
  expect([...original.transactionRefs].sort()).toEqual([...SEEDED_REFS].sort());
  expect(original.amendedByFilingId).toBe(correction.filingId);

  // the superseded copy is still openable, in full
  const copy = await book.copy(first.filingId);
  expect(copy.payload.filing.fwrReceipt).toBe("FWR-SEAM-0001");
  expect(copy.payload.filing.refs).toHaveLength(4);
});
