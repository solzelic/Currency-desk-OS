/* Identity check on the client file. Checks are off, so Start stays hidden.
   The line does not claim the desk keeps no ID image of its own. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

test("the client file hides Start while identity checks are off", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const created = await page.evaluate(async () => {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: "Id Check Client", kind: "individual" }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await page.locator('[data-app="clients"]').click();
  await page.getByText("Id Check Client", { exact: true }).click();
  const block = page.getByTestId("identity-check");
  await expect(block).toBeVisible();
  await expect(block).toContainText("Persona's ID photo and selfie are not copied to this desk.");
  await expect(block.getByRole("button", { name: "Start identity check" })).toHaveCount(0);
  await expect(block).not.toContainText("Approved");
});
