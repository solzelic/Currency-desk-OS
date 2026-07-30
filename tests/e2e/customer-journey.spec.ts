/* ============================================================
   One customer, all the way through.

   Every bug found on the night this was written lived at a SEAM — where
   the design meets the build, where the panel hands off to the customer's
   own screens, where finishing setup hands off to the OS. Each piece was
   tested on its own and the joins were tested by nobody, because nobody
   had ever walked a single person from the front door to a working desk.

   So that is what this does, in a real browser, against the server as
   Render runs it. It is deliberately one long walk rather than several
   tidy tests: the bugs were in the handovers, and a handover only exists
   if the step before it really happened.

   What it would have caught, of the eight:
     · Settings dead                    (the parse gate covers that one)
     · new desk named after another company
     · desk blank on first open
     · Open never filling
     · being asked to sign in again after setting a password
   ============================================================ */
import { test, expect, signInAsOperator, rendered, codeFor, logSize } from "./fixtures";

const stamp = Date.now();
const APPLICANT = {
  name: "Nadia Haddad",
  email: `nadia-${stamp}@harbourfx.example`,
  shop: "Harbour FX",
  slug: `harbour${stamp}`.slice(0, 24),
};

test.describe.configure({ mode: "serial" });

let reference = "";

test("an application arrives from the public site", async ({ page, request }) => {
  await page.goto("/signup");
  await rendered(page, /Run the whole exchange|Apply for early access/i);

  /* Posted the way the page posts it. Driving eight wizard screens by
     clicking is a test of the wizard, which the design owns and changes
     often; what must not break is that the site can lodge an application
     the server accepts, with the fields the panel reads. */
  const res = await request.post("/api/enquiries", {
    data: {
      kind: "early_access",
      email: APPLICANT.email,
      name: APPLICANT.name,
      details: {
        jurisdiction: "CA", workspace: `${APPLICANT.slug}.currencydeskos.com`,
        monthlyVolume: "$500K – $2M", phone: "+1 4165550148", bestTime: "Afternoons",
      },
    },
  });
  expect(res.status()).toBe(201);
  reference = (await res.json()).reference;
  expect(reference).toMatch(/^CD-[2-9A-HJ-NP-Z]{6}$/);
});

test("the operator sees it in review, already acknowledged", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/admin#/applications");
  await page.reload();
  await rendered(page, "In review");

  // the journey line, and their number on the card — the thing you ring
  await expect(page.getByText(APPLICANT.name).first()).toBeVisible();
  await expect(page.getByText("+1 416 555 0148").first()).toBeVisible();
});

test("approving is one press, and it hands them a working link", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/admin#/applications");
  await page.reload();
  await rendered(page, "In review");

  const card = page.locator('[data-stage="reviewing"]').getByText(APPLICANT.name).first();
  await card.waitFor();
  await page.locator('[data-stage="reviewing"] button', { hasText: "Approve & invite" }).first().click();

  await expect(page.locator('[data-stage="invited"]').getByText(APPLICANT.name).first()).toBeVisible();

  // the link in the email opens their setup; before approval it opened nothing
  const state = await page.request.get(`/api/onboarding/${reference}/state`);
  expect(state.status()).toBe(200);
});

/* Setting the desk up and landing inside it are ONE act, and they are
   written as one test on purpose. Playwright gives each test a clean
   browser context, so splitting them throws away the session that opening
   the desk creates — which is precisely the handover that was broken, and
   splitting it would have hidden the bug rather than caught it. */
test("they set the desk up, and land inside their own desk signed in", async ({ page }) => {
  await page.goto(`/onboarding/${reference}`);
  await rendered(page, /set up|desk|welcome/i);

  /* Their answers, through the endpoint their own page saves to. The
     owner email is deliberately DIFFERENT from the one they applied
     with — that is allowed, and it is what stopped applications ever
     closing, so the walk has to include it. */
  const owner = `owner-${stamp}@harbourfx.example`;
  const before = logSize();
  await page.request.put(`/api/onboarding/${reference}/state`, {
    data: {
      at: 3,
      data: {
        ownerEmail: owner, operatingName: APPLICANT.shop, bizName: `${APPLICANT.shop} Inc.`,
        plan: "full", city: "Toronto", currencies: ["USD", "EUR"],
      },
    },
  });
  const sent = await page.request.post(`/api/onboarding/${reference}/verify/send`, { data: { data: {} } });
  expect(sent.status()).toBe(200);
  expect((await sent.json()).sentTo).toBe(owner);

  const code = await codeFor(owner, before);
  expect((await page.request.post(`/api/onboarding/${reference}/verify/check`, { data: { code } })).status()).toBe(200);

  const launched = await page.request.post(`/api/onboarding/${reference}/launch`, {
    data: { data: { ownerPass: "a-strong-pass-2026" } },
  });
  expect(launched.status()).toBe(201);
  const body = await launched.json();
  expect(body.signedIn).toBe(true);
  expect(body.tenantId).toMatch(/^tnt-/);

  /* The handover that was broken: setting a password and then being asked
     for it again, for an account thirty seconds old. */
  await page.goto("/app");
  await rendered(page, /Where are you working|CHOOSE YOUR STATION|LEDGER/i);
  const shell = await page.locator("body").innerText();
  expect(shell).not.toMatch(/Staff sign-in/i);

  // and it is THEIR desk, not the demo's
  expect(shell).toContain(APPLICANT.shop);
  expect(shell).not.toMatch(/York Foreign Exchange/i);

  // through the station picker into the desk itself
  const open = page.getByRole("button", { name: /OPEN WORKSPACE/i }).first();
  if (await open.count()) { await open.click(); await rendered(page, /LEDGER|RATE BOARD/i); }
  const desk = await page.locator("body").innerText();
  expect(desk).toContain(APPLICANT.shop);
  // a brand-new desk has no trading on it
  expect(desk).toMatch(/No records match|No transactions|0\s*records/i);
});

/* The funnel has to agree with the customer list. It did not: a desk
   opened under a different owner address left its application in Invited
   forever, and Open stayed empty however many desks existed. */
test("the application closes, and the desk shows up as Open", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/admin#/applications");
  await page.reload();
  await rendered(page, "In review");

  await expect(page.locator('[data-stage="accepted"]').getByText(APPLICANT.name).first()).toBeVisible();
  await expect(page.locator('[data-stage="invited"]').getByText(APPLICANT.name)).toHaveCount(0);
});

/* One of the written emails, sent to a named person by hand.

   Approving sends the invitation on its own and the Inbox sends a reply
   somebody typed; this is the case in between, and it is the one where a
   mistake is expensive — an email addressed from a form field rather than
   from the record goes to the wrong person, and there is no unsending it.
   So the walk checks the two things that make it safe: the preview is
   filled in from their record, and what was sent is on their thread
   afterwards saying honestly whether it left the building. */
test("an operator can send them one of the written emails", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/admin#/applications");
  await page.reload();
  await rendered(page, "In review");

  await page.locator('[data-stage="accepted"]').getByText(APPLICANT.name).first().click();
  await rendered(page, "Send them an email");

  await page.getByRole("button", { name: "We're looking at your application" }).click();
  // their name, which nothing on this screen typed
  await expect(page.getByText(new RegExp(APPLICANT.name.split(" ")[0]!)).first()).toBeVisible();

  await page.getByRole("button", { name: /^Send it again to/ }).click();
  await expect(page.getByText(/What we have sent them/i).first()).toBeVisible();
  await expect(page.getByText(/not actually sent/i).first()).toBeVisible();
});

/* Somebody writes in, and we answer them without leaving the panel. */
test("a message from the contact page can be replied to", async ({ page }) => {
  const from = `writes-${stamp}@shop.example`;
  const res = await page.request.post("/api/enquiries", {
    data: { kind: "contact", email: from, name: "Quinn Reyes", details: { topic: "Pricing", message: "Do you support EUR?" } },
  });
  expect(res.status()).toBe(201);

  await signInAsOperator(page);
  await page.goto("/admin#/inbox");
  await page.reload();
  await rendered(page, "Needs a reply");

  await page.getByText("Quinn Reyes").first().click();
  await rendered(page, "Do you support EUR?");
  await page.locator("textarea").first().fill("Yes — EUR is supported, nothing to switch on.");
  await page.getByRole("button", { name: "Send reply" }).click();

  // the reply joins the thread, and says honestly that it did not send
  await expect(page.getByText("Yes — EUR is supported, nothing to switch on.").first()).toBeVisible();
  await expect(page.getByText(/not actually sent/i).first()).toBeVisible();
});
