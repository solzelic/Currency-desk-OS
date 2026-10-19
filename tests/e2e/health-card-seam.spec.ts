/* ============================================================
   A health card on file, from the desk's side of the seam.

   The server refuses a new health card and never sends a stored health
   number. This drives the screen over a row an older desk already wrote
   — the number is in the database — and asks whether the number reaches
   the browser anyway: the client file, search, the edit pickers, this
   browser's saved copies, or an LCTR identifier.
   ============================================================ */
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, rendered } from "./fixtures";

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no client records");

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const NAME = `Hana Health ${RUN}`;
const SECRET = `HN-${RUN}-PRIV`;
const SHOWN = "Health card — not accepted as ID";
const REFUSAL = "Health cards can't be used as ID. Record a current photo ID.";

async function openClients(page: Page) {
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
}

test("a stored health card is named as not accepted, and its number is nowhere on the desk", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);

  const created = await page.evaluate(async (name) => {
    const made = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: name, region: "ON" }),
    });
    return { status: made.status, body: await made.json() };
  }, NAME);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const clientId = created.body.clientId as string;

  /* A new one is refused, in the words the teller sees. */
  const refused = await page.evaluate(async ({ clientId, secret }) => {
    const res = await fetch(`/api/clients/${clientId}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "OHIP", docNumber: secret, expiresOn: "2030-04-01", isPrimary: true }),
    });
    return { status: res.status, body: await res.json() };
  }, { clientId, secret: SECRET });
  expect(refused.status).toBe(422);
  expect(refused.body).toMatchObject({ error: "HEALTH_CARD_NOT_ID", detail: REFUSAL });

  /* One an older desk already stored, straight into the table. */
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      `INSERT INTO desk_client_identity_documents
         (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, issuing_jurisdiction, expires_on, is_primary, created_by)
       SELECT $1, client_id, tenant_id, legal_entity_id, 'OHIP', $2, 'ON', '2030-04-01', true, 'test:legacy'
         FROM desk_clients WHERE client_id=$3`,
      [`doc_e2e_${RUN}`, SECRET, clientId],
    );
  } finally {
    await pool.end();
  }

  /* And a copy this browser saved before the desk refused them. */
  await page.evaluate(({ name, secret }) => {
    localStorage.setItem("cdos_tour_v1", JSON.stringify({
      "a.singh": { status: "finished", tour: "employee", at: Date.now() },
      "tnt-yorkfx:a.singh": { status: "finished", tour: "employee", at: Date.now() },
    }));
    localStorage.setItem("cdos_clients_v1", JSON.stringify({
      [name]: { idType: "OHIP", idNum: secret, idExpiry: "2030-04-01", ids: [{ type: "Care Card", num: secret }] },
    }));
  }, { name: NAME, secret: SECRET });

  await page.reload();
  await landOnDesktop(page);

  const local = await page.evaluate(() => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) out.push(localStorage.getItem(key) || "");
    }
    return out.join("\n");
  });
  expect(local).not.toContain(SECRET);

  await openClients(page);
  const card = page.locator('div[role="button"]').filter({ hasText: NAME }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  const search = page.getByPlaceholder("Search name, phone, or a file on their record…");
  await search.fill(SECRET);
  await expect(page.locator('div[role="button"]').filter({ hasText: NAME })).toHaveCount(0);
  await search.fill("");
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.click();

  await expect(page.getByText(SHOWN).first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(SECRET);

  /* Edit: the pickers come from the catalogue. The health card is shown
     as not accepted and cannot be chosen; the BC Services Card can. */
  const file = page.locator("div.fixed.inset-0").filter({ hasText: NAME }).last();
  await file.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByText(REFUSAL).first()).toBeVisible();
  const options = await page.locator("select option").evaluateAll((nodes) =>
    nodes.map((node) => ({ text: (node as HTMLOptionElement).text, disabled: (node as HTMLOptionElement).disabled })),
  );
  expect(options.map((o) => o.text)).toContain("BC Services Card");
  expect(options.map((o) => o.text)).toContain("Provincial/Territorial Photo ID");
  expect(options.map((o) => o.text)).not.toContain("Health Card");
  const health = options.filter((o) => o.text === SHOWN);
  expect(health.length).toBeGreaterThan(0);
  expect(health.every((o) => o.disabled)).toBe(true);
  expect(await page.locator("body").innerText()).not.toContain(SECRET);
});

test("an LCTR identifier is never a health number, and is a passport when the file has one", async ({ page }) => {
  await signInAtDesk(page);
  await page.waitForFunction(() => (window as any).CDOS && (window as any).CDOS.LCTR && (window as any).CDOS.LCTR.buildMap);
  const fields = await page.evaluate((secret) => {
    const regime = {
      id: "FINTRAC", authority: "FINTRAC", country: "Canada", currency: "CAD", threshold: 10000, aggHours: 24,
      largeCode: "LCTR", largeLabel: "Large Cash Transaction Report",
      wireCode: "EFTR", wireLabel: "Electronic Funds Transfer Report",
      strCode: "STR", strLabel: "Suspicious Transaction Report",
    };
    const settings = { timezone: "America/Toronto", structuringDays: 7, reportingEntityNumber: "8847213", locationNumber: "00001" };
    const row = (ref: string, customer: string) => ({
      ref, customer, date: "2026-10-01", time: "10:00", inCcy: "CAD", inAmt: 12000, outCcy: "USD", outAmt: 8000, type: "Exchange",
    });
    const clients = {
      "Health Only": { idType: "OHIP", idNum: secret, province: "ON", country: "Canada" },
      "Has Passport": { idType: "Passport", idNum: "PA-LCTR-1", province: "ON", country: "Canada" },
    };
    const read = (customer: string) => {
      const blocks = (window as any).CDOS.LCTR.buildMap(
        { kind: "LCTR", refs: ["R-1"], subject: customer, basis: "conductor", amount: 12000 },
        { settings, clients, rows: [row("R-1", customer)], regime },
      );
      const out: Record<string, string> = {};
      for (const block of blocks) for (const inst of block.instances || []) for (const f of inst.fields || []) {
        if (f && f.id) out[f.id] = f.value || "";
      }
      return out;
    };
    return { health: read("Health Only"), passport: read("Has Passport") };
  }, SECRET);
  expect(JSON.stringify(fields.health)).not.toContain(SECRET);
  expect(fields.health).toMatchObject({ cd_idtype: "", cd_idnum: "", cd_idjur: "" });
  expect(fields.passport).toMatchObject({ cd_idtype: "Passport", cd_idnum: "PA-LCTR-1", cd_idjur: "ON, Canada" });
});
