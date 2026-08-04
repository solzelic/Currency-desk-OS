/* ============================================================
   Switching tills, where the screen meets the book.

   The defect this file exists for: the Cash Drawer's till switcher renamed
   its own header and nothing else. Pick "Till 2 — Express", confirm, type a
   count, save — and PostgreSQL recorded

     till_id | actor_id           | currency | expected | counted
     till-01 | tnt-yorkfx:a.singh | CAD      | 27000.00 | 12345.00

   A teller who moved to the second drawer and counted it had overwritten the
   FIRST drawer's count with the second drawer's cash, inventing a large
   variance on a till nobody had touched. Nothing crashed. The screen said
   Till 2 the whole time; only the database knew.

   A server test could not see this — the ledger did exactly what it was
   asked. A browser test could not see it either — the header said Till 2, as
   requested. It lives in the join, so it is tested at the join: drive the
   real switcher in a real browser, then ask PostgreSQL which till the count
   landed on.

   FIXTURE, AND WHY IT IS SHAPED THIS WAY

   The defect needs a branch with two tills, and the seeded desk has one. The
   second workspace is inserted here and REMOVED afterwards, because the other
   seam suites call the ledger without a workspace header and the server
   rightly refuses that once a branch has two tills. The ledger rows the test
   writes to the second till are left where they are: this book is append-only
   on purpose, and a test that deleted from it would be rehearsing the one
   thing the product must never do. So nothing here asserts on a count being
   the only one in the table — each run counts its own amount.
   ============================================================ */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* `pg` is the server's dependency, not the repo root's, and this file is
   compiled from the root. Resolving it from the server package is honest
   about where it comes from and avoids a second copy in the tree. */
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as { Pool: new (c: { connectionString: string }) => any };

const TENANT = "tnt-yorkfx";
const ENTITY = "le-yorkfx-canada";
const BRANCH = "br-yorkville";
const FIRST_WORKSPACE = "ws-yorkville-till-01";
/* The second drawer at the same branch — the whole point. */
const SECOND_WORKSPACE = "ws-seam-till-02";
const SECOND_TILL = "till-02";
/* And a till at a branch this teller is not posted at, which must never be
   offered to them however many tills the desk has. */
const FOREIGN_BRANCH = "br-seam-elsewhere";
const FOREIGN_WORKSPACE = "ws-seam-elsewhere";

/* A count amount nobody else in this database has used. The ledger keeps
   every count ever taken, so "which till did MY count land on" has to be a
   question about this run's figure. */
const COUNTED = String(70000 + (Date.now() % 20000));

let pool: any;

/* Tailwind, for real, because this test clicks a MODAL.

   The shared fixture stubs the Tailwind CDN out with an empty script, which
   is right for everything that only reads text — but the confirmation dialog
   is positioned entirely by `fixed inset-0`, and without those rules it lands
   in the document flow underneath a window's resize handle and cannot be
   clicked. The compiled shell links the built stylesheet itself and never
   asks the CDN, so this only fires when the uncompiled `CurrencyDesk OS.html`
   is being served; there it serves exactly the same stylesheet. */
const TAILWIND = (() => {
  try {
    return readFileSync(path.join(process.cwd(), "web", "app", "tw.css"), "utf8");
  } catch {
    return "";
  }
})();
test.beforeEach(async ({ page }) => {
  await page.route("**cdn.tailwindcss.com**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `document.head.appendChild(Object.assign(document.createElement("style"),{textContent:${JSON.stringify(TAILWIND)}}));`,
    }));
});

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [SECOND_WORKSPACE, TENANT, ENTITY, BRANCH, SECOND_TILL],
  );
  await pool.query(
    `INSERT INTO branches (id,tenant_id,legal_entity_id,name)
     VALUES ($1,$2,$3,'Elsewhere Desk') ON CONFLICT DO NOTHING`,
    [FOREIGN_BRANCH, TENANT, ENTITY],
  );
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,'till-99') ON CONFLICT DO NOTHING`,
    [FOREIGN_WORKSPACE, TENANT, ENTITY, FOREIGN_BRANCH],
  );
});

test.afterAll(async () => {
  if (!pool) return;
  /* Put the branch back to one till. The ledger rows written against the
     second one stay — see the header. */
  await pool.query("DELETE FROM sessions WHERE workspace_id = ANY($1)", [
    [SECOND_WORKSPACE, FOREIGN_WORKSPACE],
  ]);
  await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [
    [SECOND_WORKSPACE, FOREIGN_WORKSPACE],
  ]);
  await pool.query("DELETE FROM branches WHERE id=$1", [FOREIGN_BRANCH]);
  await pool.end();
});

/** State the till's opening position through the product's own route. */
async function openingBalances(page: Page, workspaceId: string, balances: Record<string, string>) {
  return page.evaluate(
    async ([ws, body]) => {
      const r = await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": ws as string },
        body: JSON.stringify({ balances: body }),
      });
      return r.status;
    },
    [workspaceId, balances] as [string, Record<string, string>],
  );
}

async function openCashDrawer(page: Page) {
  await page.getByText(/Cash Drawer/i).first().click();
  await expect(page.getByText(/ledger till/i).first()).toBeVisible({ timeout: 45_000 });
}

/* The till this screen says the ledger is answering for. It is one line of
   the Cash Drawer's own header and it is the contradiction made visible: it
   read "ledger till till-01" while the title beside it read "Till 2". */
async function ledgerTillOnScreen(page: Page) {
  const body = await page.locator("body").innerText();
  const match = body.match(/ledger till\s+(\S+)/);
  return match ? match[1]! : null;
}

/* The Cash Drawer's OWN switcher, not the one in the tenant bar — both carry
   the same title, and only this one sits next to the ledger till label. */
const switcher = (page: Page) =>
  page.locator(
    'xpath=//button[@title="Switch till at this location" and not(ancestor::*[@id="tenantbar"])]',
  );
const switcherMenu = (page: Page) =>
  page.locator(
    'xpath=//span[button[@title="Switch till at this location"] and not(ancestor::*[@id="tenantbar"])]/div',
  );

test("switching tills moves the ledger, and the count lands on the till the screen names", async ({ page }) => {
  await signInAtDesk(page, "a.singh");

  /* Both drawers hold their own money. Deliberately different figures: a
     count written against the wrong till shows up as a variance against the
     wrong expected, which is exactly the shape of the reported defect.
     409 means a previous run already stated the position — an opening
     position is stated once and never restated, so that is fine. */
  expect([201, 409]).toContain(await openingBalances(page, FIRST_WORKSPACE, { CAD: "27000.00" }));
  expect([201, 409]).toContain(await openingBalances(page, SECOND_WORKSPACE, { CAD: "9000.00" }));

  await openCashDrawer(page);
  const before = await ledgerTillOnScreen(page);
  expect(before).toBe("till-01");

  // pick the other drawer, and confirm it the way a teller does
  await switcher(page).click();
  const options = switcherMenu(page).getByRole("button");
  await expect(options.first()).toBeVisible();
  await options.nth(1).click();
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();

  /* THE ASSERTION THE OLD CODE FAILS. The switch either moved the ledger or
     it renamed a label; there is no third thing it could have done, and the
     label beside the title is where the difference shows. */
  await expect
    .poll(() => ledgerTillOnScreen(page), { timeout: 20_000 })
    .toBe(SECOND_TILL);

  // and the title now says the same drawer the ledger just said
  await expect(switcher(page)).toHaveText(new RegExp(SECOND_TILL));

  // a drawer nobody has opened has no session; open it before counting
  const openButton = page.getByRole("button", { name: /Open the till/i }).first();
  if (await openButton.isVisible().catch(() => false)) {
    await openButton.click();
    await expect(page.getByText(/Session #\d+ open/)).toBeVisible({ timeout: 20_000 });
  }

  await page.locator('button:has-text("CAD")').first().click();
  await page.getByRole("button", { name: /Enter total/i }).first().click();
  await page.locator('input[placeholder="0.00"]').first().fill(COUNTED);
  await page.getByRole("button", { name: /Save count/i }).first().click();

  /* THE ASSERTION THIS FILE EXISTS FOR. Ask PostgreSQL, not the screen:
     which till holds a count of this amount, and who took it. */
  const countsOfThisRun = async () =>
    (
      await pool.query(
        `SELECT b.till_id, b.actor_id, c.expected_amount
           FROM ledger_till_count_batches b
           JOIN ledger_till_counts c ON c.batch_id = b.batch_id
          WHERE b.branch_id=$1 AND c.currency='CAD' AND c.counted_amount=$2`,
        [BRANCH, `${COUNTED}.00`],
      )
    ).rows as { till_id: string; actor_id: string; expected_amount: string }[];

  await expect.poll(async () => (await countsOfThisRun()).length, { timeout: 20_000 }).toBe(1);
  const landed = (await countsOfThisRun())[0]!;

  expect(landed.till_id.trim()).toBe(SECOND_TILL);
  // the till the SCREEN named, and the till the BOOK wrote to, are one till
  expect(landed.till_id.trim()).toBe(await ledgerTillOnScreen(page));
  // ...counted against the second drawer's own expected figure, not the first's
  expect(Number(landed.expected_amount)).toBe(9000);
  // ...and signed by the person actually at the keyboard
  expect(landed.actor_id).toBe("tnt-yorkfx:a.singh");

  /* The confirmation modal promises the switch is "stamped to the audit trail
     with your name and the time". It said that while writing nothing. */
  const audit = await pool.query(
    `SELECT actor_id, workspace_id
       FROM ledger_audit_events
      WHERE action='till.select' AND workspace_id=$1
      ORDER BY created_at DESC LIMIT 1`,
    [SECOND_WORKSPACE],
  );
  expect(audit.rowCount).toBe(1);
  expect(audit.rows[0].actor_id).toBe("tnt-yorkfx:a.singh");
});

test("the chosen till survives a reload", async ({ page }) => {
  await signInAtDesk(page, "a.singh");
  await openCashDrawer(page);
  await switcher(page).click();
  await switcherMenu(page).getByRole("button").nth(1).click();
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();
  await expect.poll(() => ledgerTillOnScreen(page), { timeout: 20_000 }).toBe(SECOND_TILL);

  /* A switch that is forgotten on reload puts somebody back on another
     drawer without telling them. Either it lasts or the desk does not claim
     it does; it lasts. */
  await page.reload();
  await openCashDrawer(page);
  await expect.poll(() => ledgerTillOnScreen(page), { timeout: 45_000 }).toBe(SECOND_TILL);
});

test("the till menu names only tills this desk has, and only operators the ledger has", async ({ page }) => {
  await signInAtDesk(page, "a.singh");
  await openCashDrawer(page);
  await switcher(page).click();
  const menu = await switcherMenu(page).innerText();

  // both of this branch's drawers, as the ledger names them
  expect(menu).toContain("till-01");
  expect(menu).toContain(SECOND_TILL);
  /* And nothing from the branch next door. The list is scoped to the branch
     this session is posted at, so an unauthorized drawer is not something the
     teller has to know better than to pick — it is not offered. */
  expect(menu).not.toContain("till-99");

  /* The menu used to announce "Till 2 — Express · M. Costa on now" for a till
     that had never held a session, naming somebody `ledger_principals` has
     never heard of. Whoever it names now, it names from the book. */
  const roster = await page.evaluate(() =>
    fetch("/api/ledger/till-roster").then((r) => r.json()),
  );
  const named = (roster.workspaces as { tillId: string; session: { status: string; openedBy: string } | null }[])
    .filter((w) => w.session && w.session.status === "open")
    .map((w) => w.session!.openedBy.split(":").pop());
  for (const line of menu.split("\n")) {
    const claim = line.match(/·\s+(\S+)\s+on now/);
    if (claim) expect(named).toContain(claim[1]);
  }
  expect(menu).not.toContain("M. Costa");
});
