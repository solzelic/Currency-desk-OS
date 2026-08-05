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
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, rendered } from "./fixtures";
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
async function openDesk(page: Page, staffId = "a.singh") {
  await signInAtDesk(page, staffId);
  const compiledIsCurrent = await page.evaluate(() => !!(window as any).CDOS?.ClientIdViewer);
  if (compiledIsCurrent) return;
  console.warn(
    "[client-records-seam] web/app is older than os-src — walking the buildless shell. " +
      "Run `npm run build:os` and this walks the compiled bundle instead.",
  );
  await page.goto("/CurrencyDesk%20OS.html");
  await landOnDesktop(page);
  const loaded = await page.evaluate(() => !!(window as any).CDOS?.ClientIdViewer);
  expect(loaded, "the buildless shell did not load the client records code either").toBe(true);
}

async function openClients(page: Page) {
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
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
  /* The profile opens on the new contact. Waiting for it is what makes
     the next step's assertions about a real record rather than a race. */
  await page.getByText(name).first().waitFor({ state: "visible", timeout: 20_000 });
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
  await page.reload();
  await landOnDesktop(page);
  await openClients(page);
  await page.getByText(RENAMED_AFTER).first().click();
  await expect(page.getByText(transactionRef).first()).toBeVisible({ timeout: 20_000 });
});

test("two people with the same name are two files, and the desk is told", async ({ page }) => {
  await openDesk(page);
  const server = desk(page);
  await openClients(page);
  await addContact(page, TWIN);
  await page.keyboard.press("Escape");
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
  await page.reload();
  await landOnDesktop(page);
  await openClients(page);
  await page.getByText(DOCUMENTED).first().click();
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
