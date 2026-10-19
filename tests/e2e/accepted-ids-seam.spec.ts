/* ============================================================
   Settings → Accepted IDs, from the screen to the server and back.

   The server suite proves the route and the refusals. What it cannot
   prove is that the owner's switch reaches the route, that a refused
   save on screen says the server's sentence rather than "Saved", that a
   manager sees the list without being able to change it, and that the
   client file and its ID picker follow what the owner chose. So this
   drives the real Settings screen and the real client file, and asks
   the server what it now holds.

   The seam database outlives a run, so every test hands the list back
   to the pack first and last.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no client records");

const ROUTE = "/api/clients/accepted-id-types";
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const NO_LONGER = "This shop no longer accepts National Identity Card. Record another ID at the next visit.";

/** What the server says this shop accepts, asked from inside the page. */
const book = (page: Page) =>
  page.evaluate((route) => fetch(route).then((r) => r.json()), ROUTE);

const putList = (page: Page, accepted: string[] | null) =>
  page.evaluate(
    ({ route, accepted }) =>
      fetch(route, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accepted }),
      }).then((r) => r.status),
    { route: ROUTE, accepted },
  );

/* Scoped to Settings' own rail, the same way the other settings seams
   do it: a top-bar app can share a name with a rail item. */
async function openAcceptedIds(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  await page.locator('div[style*="width: 212px"]').getByText(/Accepted IDs/).first().click();
  await rendered(page, /The ID types your staff can record/i);
  await page.getByTestId("accepted-ids").waitFor({ state: "visible", timeout: 30_000 });
}

const switchFor = (page: Page, code: string) =>
  page.getByTestId(`accepted-id-${code}`).getByRole("switch");

test("the owner switches a type off, and the server is what changed", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  expect(await putList(page, null)).toBe(200);
  await openAcceptedIds(page);

  await expect(switchFor(page, "national_id_card")).toHaveAttribute("aria-checked", "true");
  /* The health card is locked off, with the reason beside it. */
  const health = page.getByTestId("accepted-id-health_card");
  await expect(health.getByRole("switch")).toBeDisabled();
  await expect(health.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(health).toContainText("FINTRAC says not to use a health card where provincial law forbids it.");

  await switchFor(page, "national_id_card").click();

  /* THE SEAM. The server was asked, not the switch. */
  await expect
    .poll(async () => (await book(page)).accepted.includes("national_id_card"), { timeout: 15_000 })
    .toBe(false);
  await expect(switchFor(page, "national_id_card")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible();

  expect(await putList(page, null)).toBe(200);
});

test("a refused save shows the server's sentence and does not say Saved", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  expect(await putList(page, ["passport", "business_number"])).toBe(200);
  await openAcceptedIds(page);
  await expect(switchFor(page, "passport")).toHaveAttribute("aria-checked", "true");

  /* Passport is the only photo ID left on. */
  await switchFor(page, "passport").click();
  await expect(page.getByRole("alert").filter({ hasText: "Keep at least one photo ID switched on." })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toHaveCount(0);
  await expect(switchFor(page, "passport")).toHaveAttribute("aria-checked", "true");
  expect((await book(page)).accepted).toEqual(["passport", "business_number"]);

  expect(await putList(page, null)).toBe(200);
});

test("a manager sees the list read-only, and the server refuses them anyway", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  expect(await putList(page, null)).toBe(403);
  await openAcceptedIds(page);

  await expect(page.getByText("Only the owner can change which IDs this shop accepts.").first()).toBeVisible();
  await expect(switchFor(page, "passport")).toBeDisabled();
  await expect(switchFor(page, "passport")).toHaveAttribute("aria-checked", "true");
  expect((await book(page)).canChange).toBe(false);
});

test("the client file keeps a switched-off ID, says so, and its picker stops offering the type", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  expect(await putList(page, null)).toBe(200);
  const name = `Nadia National ${RUN}`;

  const made = await page.evaluate(async (legalName) => {
    const created = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName }),
    }).then((r) => r.json());
    const doc = await fetch(`/api/clients/${created.clientId}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "National Identity Card", docNumber: "784-SEAM-1", expiresOn: "2031-01-01", isPrimary: true }),
    });
    return { clientId: created.clientId as string, status: doc.status };
  }, name);
  expect(made.status).toBe(201);

  expect(await putList(page, ["drivers_licence", "passport", "provincial_photo_id", "permanent_resident_card",
    "citizenship_card", "bc_services_card", "business_number", "incorporation_certificate",
    "master_business_licence", "articles_of_incorporation"])).toBe(200);

  /* A new one is refused at the server, in the words the screen shows. */
  const refused = await page.evaluate(async (clientId) => {
    const res = await fetch(`/api/clients/${clientId}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "Emirates ID", docNumber: "784-SEAM-2", isPrimary: false }),
    });
    return { status: res.status, body: await res.json() };
  }, made.clientId);
  expect(refused.status).toBe(422);
  expect(refused.body.detail).toBe(
    "This shop doesn't accept National Identity Card. The owner can change this in Settings → Accepted IDs.",
  );

  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
  const card = page.locator('div[role="button"]').filter({ hasText: name }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.click();

  /* The document is still on file, with its number, and a quiet line. */
  await expect(page.getByText(NO_LONGER).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("784-SEAM-1").first()).toBeVisible();

  /* The picker offers what the shop accepts. The type on file stays
     visible as the current value and cannot be chosen again. */
  const file = page.locator("div.fixed.inset-0").filter({ hasText: name }).last();
  await file.getByRole("button", { name: "Edit" }).click();
  const options = await page.locator("select option").evaluateAll((nodes) =>
    nodes.map((node) => ({ text: (node as HTMLOptionElement).text, disabled: (node as HTMLOptionElement).disabled })),
  );
  expect(options.map((o) => o.text)).toContain("Passport");
  const national = options.filter((o) => o.text === "National Identity Card");
  expect(national.length).toBeGreaterThan(0);
  expect(national.every((o) => o.disabled)).toBe(true);

  expect(await putList(page, null)).toBe(200);
});
