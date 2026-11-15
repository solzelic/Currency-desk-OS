/* Identity check on the client file.
   m.costa stays active when the staging owner replaces j.masri.
   Checks off: Start stays hidden.
   A stored check: the older card does not say Persona is not connected. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server/package.json"));
const { Client } = requireFromServer("pg") as { Client: new (config: { connectionString: string }) => {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
} };

test("the client file hides Start while identity checks are off", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "m.costa");
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
  await expect(block).toContainText("ID details are not saved from this check yet.");
  await expect(block.getByRole("button", { name: "Start identity check" })).toHaveCount(0);
  await expect(block).not.toContainText("Approved");
});

test("a stored check does not say Persona is not connected", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "m.costa");
  const created = await page.evaluate(async () => {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: "Passed Check Client", kind: "individual" }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const clientId = created.body.clientId as string;
  expect(clientId).toMatch(/^cli_/);
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO idv_shop_config (shop_id, provider, checks_enabled)
       VALUES ('le-yorkfx-canada', 'persona', true)
       ON CONFLICT (shop_id) DO UPDATE SET checks_enabled = true`,
    );
    await db.query(
      `INSERT INTO idv_inquiries
        (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, status, client_id)
       VALUES ($1, 'le-yorkfx-canada', 'br-yorkville', 'tnt-yorkfx:m.costa', 'persona', $2, 'approved', $3)`,
      [`ref_${clientId}`, `inq_${clientId}`, clientId],
    );
    await page.locator('[data-app="clients"]').click();
    await page.getByText("Passed Check Client", { exact: true }).click();
    const file = page.locator(".client-file");
    await expect(file.getByTestId("identity-check")).toContainText("Check passed");
    await expect(file.getByTestId("identity-check")).toContainText("ID details are not saved from this check yet.");
    await expect(file.getByTestId("identity-check").getByRole("button", { name: "Start identity check" })).toHaveCount(0);
    await expect(file.getByTestId("client-identity")).not.toContainText("Persona is not connected");
    await expect(file).toContainText("Missing ID");
  } finally {
    await db.query(`DELETE FROM idv_inquiries WHERE client_id = $1`, [clientId]);
    await db.query(`UPDATE idv_shop_config SET checks_enabled = false WHERE shop_id = 'le-yorkfx-canada'`);
    await db.end();
  }
});
