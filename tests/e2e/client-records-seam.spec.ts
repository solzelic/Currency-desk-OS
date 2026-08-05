/* ============================================================
   Where the customer file meets the record.

   Every customer this product has ever held lived in one browser, in
   `localStorage`, keyed by the customer's NAME. The four things that
   followed are the four things this file walks, in a real browser,
   against a real server:

     • a client created at the counter is ON THE SERVER, not just on
       the screen that made it;
     • renaming somebody does not orphan their transactions — the deal
       posted under the old spelling still resolves, and the old name
       still finds them;
     • two people who share a name are two files, and the desk is told;
     • opening an identity document writes a SERVER audit row, because
       "who looked at this customer's passport, and when" is a question
       a regulator asks and the answer used to be that nobody could say.

   Both halves are asserted every time. A server test and a browser test
   run side by side will each pass while the two disagree — which is
   exactly how every defect in this project so far survived a fully green
   run. See docs/CASH_OWNERSHIP_INVARIANTS.md, "testing standard".
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, ledger, rendered } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no client records");

/* Names unique to this run. The seam database outlives a run, and a test
   that asserts "two customers called X" cannot survive a second pass
   over the same database if X is a constant. */
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const RENAMED_BEFORE = `Jonh Seam ${RUN}`;
const RENAMED_AFTER = `John Seam ${RUN}`;
const TWIN = `David Twin ${RUN}`;
const DOCUMENTED = `Passport Holder ${RUN}`;

/* A one-pixel PNG. What is being proved is that the bytes leave the
   browser and that fetching them is recorded, not that Postgres can hold
   a photograph — the ceiling on real ones has its own seam test, in
   id-intake-seam.spec.ts. */
const SCAN =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* Ask the server, from inside the signed-in page: the same session, the
   same workspace header, the same answers the screen is getting.

   `json` deliberately returns the STATUS as well as the body. A fixture
   that fired a request and ignored the response is how a 500 hid here
   for months; every helper below is asserted on. */
function desk(page: Page) {
  const call = (url: string, init?: Record<string, unknown>) =>
    page.evaluate(
      async ([u, i]) => {
        const response = await fetch(u as string, {
          ...(i as Record<string, unknown>),
          headers: { "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      },
      [url, init ?? {}] as const,
    );
  return {
    call,
    async clients() {
      const answer = await call("/api/clients");
      expect(answer.status, `GET /api/clients said ${answer.status}`).toBe(200);
      return answer.body.clients as any[];
    },
    async lookup(name: string) {
      const answer = await call(`/api/clients/lookup?name=${encodeURIComponent(name)}`);
      expect(answer.status, `lookup(${name}) said ${answer.status}`).toBe(200);
      return answer.body.clients as any[];
    },
    async disclosures(clientId: string) {
      const answer = await call(`/api/clients/${clientId}/disclosures`);
      expect(answer.status, `disclosures said ${answer.status}`).toBe(200);
      return answer.body.events as any[];
    },
  };
}

const named = (clients: any[], name: string) => clients.filter((c) => c.legalName === name);

/* ---- getting to the desk with THIS change's code loaded --------------

   The server prefers the compiled apps in `web/app` when they are there,
   which is what Render serves and what this suite is meant to walk. The
   compiled bundle is a build artefact regenerated at the end of a change,
   so while a change is in flight it is the code from BEFORE it.

   Walking a stale bundle would make this whole file pass green against
   the defect it exists to catch, which is the exact failure the
   playwright config's own header is about. So it checks: if what /app
   served does not have the component this change adds, it loads the
   buildless shell — the same source the bundle is compiled FROM — and
   says so in the run output. After a rebuild, /app is what gets walked
   and this branch never fires. */
let warnedAboutBundle = false;

async function openDesk(page: Page, staffId = "a.singh") {
  await signInAtDesk(page, staffId);
  if (await page.evaluate(() => !!(window as any).CDOS?.ClientIdViewer)) return;
  if (!warnedAboutBundle) {
    warnedAboutBundle = true;
    console.warn(
      "[client-records-seam] web/app is older than os-src — walking the buildless shell instead. " +
        "Run `npm run build:os` and this walks the compiled bundle.",
    );
  }
  await useBuildlessShell(page);
}

/* The buildless shell needs one thing the compiled app does not: a
   stylesheet.

   It pulls Tailwind from a CDN at runtime, and the shared fixture
   answers that request with an empty body — deliberately, because a CDN
   is not what any of this is testing. The compiled app does not care;
   it ships `web/app/tw.css`. The buildless one does: without those
   utilities `fixed inset-0` is nothing, `z-index` has no positioned
   element to apply to, and every modal renders in normal flow BEHIND the
   desktop. Playwright then reports a button that is "visible, enabled and
   stable" and refuses to click it because the desktop is on top — which
   is a real thing to know about this page, and a miserable thing to
   discover from a CI log.

   `web/app/tw.css` is generated from these same sources, so attaching it
   is not a substitute for the product's styling. It IS the product's
   styling. */
async function useBuildlessShell(page: Page) {
  await page.goto("/CurrencyDesk%20OS.html");
  await page.addStyleTag({ url: "/web/app/tw.css" });
  await landOnDesktop(page);
  const loaded = await page.evaluate(() => !!(window as any).CDOS?.ClientIdViewer);
  expect(loaded, "the buildless shell did not load the client records code either").toBe(true);
  const positioned = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "fixed inset-0";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).position;
    probe.remove();
    return value;
  });
  expect(positioned, "web/app/tw.css did not attach — every modal will render behind the desktop").toBe("fixed");
}

/* Any reload puts an owner back on the station chooser, and a reload on
   the buildless path also drops the stylesheet above. Both are handled
   here so no test has to remember either. */
async function reopenDesk(page: Page) {
  const buildless = page.url().includes("CurrencyDesk");
  await page.reload();
  if (buildless) {
    await page.addStyleTag({ url: "/web/app/tw.css" });
  }
  await landOnDesktop(page);
}

async function openClients(page: Page) {
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
}

/* Creating a contact leaves their profile open over the whole screen —
   which is what a teller wants and what a second `New contact` click
   cannot get past. The profile closes on a click outside itself; there
   is no Escape handler on it, and pressing Escape looked like it worked
   right up until the next click timed out against the scrim. */
async function closeProfile(page: Page) {
  const scrim = page.locator("div.fixed.inset-0").last();
  if (!(await scrim.isVisible().catch(() => false))) return;
  await scrim.click({ position: { x: 6, y: 6 } });
  await scrim.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

/* The card in the contacts grid, not merely "some element with this text
   on it". A customer's name appears on several — a ledger row's own link
   to their file sits behind the grid and matched first, which Playwright
   then spent ninety seconds refusing to click because the grid is on top
   of it. The grid card is the thing a person clicks. */
async function openClientCard(page: Page, name: string) {
  const card = page.locator('div[role="button"]').filter({ hasText: name }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.click();
}

/* Create a client the way a teller does: the New-contact wizard, skipping
   the paid verification, which is the escape hatch the product offers and
   the path most contacts are actually made through. */
async function addContact(page: Page, name: string) {
  await page.getByRole("button", { name: /^New contact$/ }).click();
  const skipId = page.getByText(/^Skip — add ID later$/);
  if (await skipId.isVisible({ timeout: 5_000 }).catch(() => false)) await skipId.click();
  const field = page.getByPlaceholder("Jane Doe");
  await field.waitFor({ state: "visible", timeout: 15_000 });
  await field.fill(name);
  await page.getByText(/^Save without verifying$/).click();
  /* The PROFILE opens on the new contact, and it is the profile this
     waits for — not merely the name, which is also on the grid card
     sitting behind it. Waiting for the name let this return while the
     profile was still being fetched, so `closeProfile` found nothing to
     close and the modal then opened over the next step's button and
     swallowed its clicks for ninety seconds. */
  await page
    .locator("div.fixed.inset-0")
    .filter({ hasText: name })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
}

test("a client created at the counter is on the server, not just on the screen", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);

  const before = await server.clients();
  expect(named(before, RENAMED_BEFORE), "this run's name must be new").toHaveLength(0);

  await openClients(page);
  await addContact(page, RENAMED_BEFORE);

  /* The other half of the seam. The screen says the contact exists; the
     question is whether the SERVER does — because under the old store
     the answer was no, forever, and nothing on either side would have
     said differently. */
  await expect
    .poll(async () => named(await server.clients(), RENAMED_BEFORE).length, { timeout: 20_000 })
    .toBe(1);

  const [record] = named(await server.clients(), RENAMED_BEFORE);
  /* The identity is not the name and is not derived from it. If it were,
     everything the rest of this file asserts would be theatre. */
  expect(record.clientId).toMatch(/^cli_/);
  expect(record.clientId.toLowerCase()).not.toContain("seam");
  expect(record.kind).toBe("individual");
});

test("renaming somebody does not orphan their transactions", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);
  const [record] = named(await server.clients(), RENAMED_BEFORE);
  expect(record, "the previous test's client should still be here").toBeTruthy();

  /* The ledger's counter record for the till this session is at. It is
     the row the posting path reads, and `client_id` is what makes it a
     view of this person rather than a second customer who happens to
     share a name. */
  const counter = await server.call(`/api/clients/${record.clientId}/counter-record`, { method: "POST", body: "{}" });
  expect(counter.status, JSON.stringify(counter.body)).toBe(200);
  const customerId = counter.body.customerId as string;
  expect(customerId).toBeTruthy();

  /* Something in the drawer to trade with. Through the product's own
     route, and the answer is READ: the seam database outlives a run, so
     the honest outcomes are "set" and "already set" — anything else is a
     fault, and a fixture that shrugged at it would leave the real
     failure looking like the assertion three lines down. */
  const opened = await ledger(page).ensureOpeningBalances({
    CAD: "5000.00", USD: "5000.00", EUR: "1000.00", GBP: "1000.00",
  });
  expect(
    [200, 201].includes(opened.status) ||
      ["OPENING_BALANCES_ALREADY_SET", "TILL_ALREADY_ACTIVE"].includes(opened.body?.code),
    `opening balances: ${opened.status} ${JSON.stringify(opened.body)}`,
  ).toBe(true);

  /* Put a real deal in the book against them, through the product's own
     quote-and-post path. Fixture SQL that lies about how the product
     works is fixture SQL that stops catching the product breaking. */
  const posted = await page.evaluate(
    async ([id, key]) => {
      const openSession = await fetch("/api/ledger/till-session").then((r) => r.json());
      if (openSession.session?.status !== "open")
        await fetch("/api/ledger/till-sessions/open", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
      const attempts = [
        { from: "CAD", to: "USD", inputAmount: "50.00", direction: "customer_buy_foreign" },
        { from: "USD", to: "CAD", inputAmount: "20.00", direction: "customer_sell_foreign" },
      ];
      const refused: string[] = [];
      for (const attempt of attempts) {
        const quote = await fetch("/api/quotes", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ customerId: id, feeCad: "1.00", ...attempt }),
        });
        if (!quote.ok) { refused.push(`quote ${attempt.from}->${attempt.to}: ${quote.status} ${await quote.text()}`); continue; }
        const frozen = await quote.json();
        const post = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `${key}-${attempt.from}${attempt.to}`, purpose: "Personal travel", sourceOfFunds: "Employment income" }),
        });
        if (!post.ok) { refused.push(`post ${attempt.from}->${attempt.to}: ${post.status} ${await post.text()}`); continue; }
        return { ok: true, ...(await post.json()) };
      }
      return { ok: false, why: refused.join(" · ") };
    },
    [customerId, `seam-client-${RUN}`] as const,
  );
  expect(posted.ok, `no deal could be posted: ${(posted as any).why}`).toBe(true);
  const transactionRef = (posted as any).transactionRef as string;

  /* Now correct the spelling — the operation that used to move the key
     and take the person's history with it. */
  const renamed = await server.call(`/api/clients/${record.clientId}`, {
    method: "PATCH", body: JSON.stringify({ legalName: RENAMED_AFTER }),
  });
  expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  expect(renamed.body.clientId, "a rename must not mint a new identity").toBe(record.clientId);

  /* One: the deal is still theirs. Same customer id, same transaction. */
  const book = await server.call("/api/ledger/transactions?limit=200");
  expect(book.status).toBe(200);
  const deal = (book.body.transactions as any[]).find((t) => t.transactionRef === transactionRef);
  expect(deal, "the posted deal vanished from the book").toBeTruthy();
  expect(deal.customerId).toBe(customerId);

  /* Two: the counter record followed the rename, so the book prints the
     name the desk actually holds rather than the misspelling. */
  const stillLinked = await server.call(`/api/clients/${record.clientId}/counter-record`, { method: "POST", body: "{}" });
  expect(stillLinked.status).toBe(200);
  expect(stillLinked.body.customerId, "renaming must not fork the counter record").toBe(customerId);

  /* Three: the OLD name still finds them. This is the alias row, and it
     is the whole reason a rename is now safe — everything already filed
     under the old spelling goes on resolving, forever. */
  const byOldName = await server.lookup(RENAMED_BEFORE);
  expect(byOldName.map((c) => c.clientId)).toEqual([record.clientId]);
  expect(byOldName[0].legalName).toBe(RENAMED_AFTER);
  const byNewName = await server.lookup(RENAMED_AFTER);
  expect(byNewName.map((c) => c.clientId)).toEqual([record.clientId]);

  /* And the desk's own screen shows the deal on the renamed file. Both
     sides of the seam, not one. */
  await reopenDesk(page);
  await openClients(page);
  await openClientCard(page, RENAMED_AFTER);
  await expect(page.getByText(transactionRef).first()).toBeVisible({ timeout: 20_000 });
});

test("two people with the same name are two files, and the desk is told", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);
  await openClients(page);
  await addContact(page, TWIN);
  await closeProfile(page);
  await addContact(page, TWIN);

  await expect
    .poll(async () => named(await server.clients(), TWIN).length, { timeout: 20_000 })
    .toBe(2);

  const both = named(await server.clients(), TWIN);
  expect(both[0].clientId).not.toBe(both[1].clientId);
  /* Each knows about the other. Under the old store they were one file
     and nobody was ever told, which is the defect that made a second
     customer inherit the first one's passport and risk rating. */
  expect(both[0].sameNameClientIds).toEqual([both[1].clientId]);
  expect(both[1].sameNameClientIds).toEqual([both[0].clientId]);

  /* And it is said on the screen, where the person about to hand over
     cash can read it. */
  await expect(
    page.getByText(new RegExp(`2 customers called ${TWIN}`, "i")).first(),
  ).toBeVisible({ timeout: 20_000 });
});

test("opening an identity document writes a server audit row", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);
  await openClients(page);
  await addContact(page, DOCUMENTED);

  await expect
    .poll(async () => named(await server.clients(), DOCUMENTED).length, { timeout: 20_000 })
    .toBe(1);
  const [record] = named(await server.clients(), DOCUMENTED);

  const withDocument = await server.call(`/api/clients/${record.clientId}/documents`, {
    method: "POST",
    body: JSON.stringify({ docType: "Passport", docNumber: `PA-${RUN}`, expiresOn: "2031-01-01", scanDataUrl: SCAN }),
  });
  expect(withDocument.status, JSON.stringify(withDocument.body)).toBe(201);
  const documentId = withDocument.body.documents[0].documentId as string;

  /* The list and the record carry the document's METADATA and never its
     bytes. If either carried the picture, the audit row below would be a
     courtesy rather than a control — a teller could read the passport out
     of a response nobody recorded. */
  const listed = await server.call("/api/clients");
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain("iVBORw0KGgo");
  const one = await server.call(`/api/clients/${record.clientId}`);
  expect(one.status).toBe(200);
  expect(JSON.stringify(one.body)).not.toContain("iVBORw0KGgo");
  expect(one.body.documents[0].hasScan).toBe(true);

  const before = await server.disclosures(record.clientId);
  expect(before.filter((e) => e.action === "client.document.view")).toHaveLength(0);

  /* Open it the way a person does — the covered placeholder on the
     client's own file, clicked. */
  await reopenDesk(page);
  await openClients(page);
  await openClientCard(page, DOCUMENTED);
  const cover = page.getByRole("button", { name: /Show ID/ }).first();
  await cover.waitFor({ state: "visible", timeout: 20_000 });
  await cover.click();
  /* The screen tells the teller the opening was recorded. A control
     nobody is told about is a control nobody trusts. */
  await expect(page.getByText(/opening recorded/i).first()).toBeVisible({ timeout: 20_000 });

  const after = await server.disclosures(record.clientId);
  const views = after.filter((e) => e.action === "client.document.view");
  expect(views, "opening a passport must leave a row on the server").toHaveLength(1);
  expect(views[0].targetId).toBe(documentId);
  expect(views[0].actorId).toContain("a.singh");
  expect(views[0].detail).toContain(DOCUMENTED);
  expect(views[0].detail).toContain("Passport");
  /* Who looked, never what they saw. An audit trail that quotes passport
     numbers is a second copy of the thing being protected, in a table
     designed to be read widely and kept for years. */
  expect(views[0].detail).not.toContain(`PA-${RUN}`);
  expect(new Date(views[0].at).getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
});

/* The drop-in the transaction screen is meant to use.

   `cdos-txmodal.jsx` is held by another change, so the call site cannot
   be added here — but the component it will call can be proved, and the
   line reported, so that adding it is a one-line change with nothing to
   discover. This mounts it exactly as that line does:

     {customer && window.CDOS.ClientIdViewer && React.createElement(window.CDOS.ClientIdViewer, { name: customer, rec: clients[customer], log })}

   It is given only the customer's NAME, which is all the till has. */
test("a teller can open the ID from a customer's name alone", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);
  const [record] = named(await server.clients(), DOCUMENTED);
  expect(record, "the documented client from the previous test").toBeTruthy();
  const before = (await server.disclosures(record.clientId)).filter(
    (e) => e.action === "client.document.view",
  ).length;

  const mounted = await page.evaluate((name) => {
    const CDOS = (window as any).CDOS;
    if (!CDOS?.ClientIdViewer) return "no ClientIdViewer on window.CDOS";
    const host = document.createElement("div");
    host.id = "txmodal-callsite-probe";
    document.body.appendChild(host);
    (window as any).ReactDOM.render(
      (window as any).React.createElement(CDOS.ClientIdViewer, { name, rec: {}, log: () => {} }),
      host,
    );
    return "";
  }, DOCUMENTED);
  expect(mounted, mounted).toBe("");

  const probe = page.locator("#txmodal-callsite-probe");
  await expect(probe.getByText(/Identity documents on file/i)).toBeVisible({ timeout: 20_000 });
  await probe.getByRole("button", { name: /Show ID/ }).first().click();
  await expect(probe.getByText(/opening recorded/i)).toBeVisible({ timeout: 20_000 });

  /* Same component, same audited route: opening a passport from the
     transaction screen leaves the same row as opening it from the client
     file, because it is the same reveal. */
  const after = (await server.disclosures(record.clientId)).filter(
    (e) => e.action === "client.document.view",
  );
  expect(after.length).toBe(before + 1);
  expect(after[0].detail).toContain("Passport");
});

test("the same document opens from a second till, and stays inside the business", async ({ page }) => {
  await openDesk(page, "r.haddad");
  const server = desk(page);

  /* A different person, on whichever drawer this session landed on: the
     customer is the LEGAL ENTITY's, not the till's. Under the old store
     the second counter had never heard of them. */
  const visible = named(await server.clients(), DOCUMENTED);
  expect(visible, "one shop's customer is that shop's customer at every counter").toHaveLength(1);
  const record = visible[0];
  const documentId = record.documents[0].documentId as string;

  const revealed = await server.call(
    `/api/clients/${record.clientId}/documents/${documentId}/reveal`,
    { method: "POST", body: JSON.stringify({ purpose: "second till check" }) },
  );
  expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
  expect(revealed.body.dataUrl).toBe(SCAN);

  const views = (await server.disclosures(record.clientId)).filter(
    (e) => e.action === "client.document.view",
  );
  /* Every opening is its own row. "Somebody looked once, months ago" and
     "two people looked this morning" are different facts and a regulator
     asks about the second. */
  expect(views.length).toBeGreaterThanOrEqual(2);
  expect(views.some((e) => String(e.actorId).includes("r.haddad"))).toBe(true);
  expect(views.some((e) => String(e.detail).includes("second till check"))).toBe(true);

  /* And an unauthenticated caller gets nothing at all — asserted rather
     than assumed, because "the customer record is shared" and "the
     customer record is public" are one mistake apart. */
  const anonymous = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "omit" });
    return response.status;
  }, `/api/clients/${record.clientId}`);
  expect([401, 403]).toContain(anonymous);
});
