/* Teller starts an ID and selfie check from a staged deal.
   Persona is a local stub. The webhook writes the record.
   No thanks goes to the counter path. A teller cannot reveal the number. */
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server/package.json"));
const { Client } = requireFromServer("pg") as { Client: new (config: { connectionString: string }) => {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, string>[] }>;
  end(): Promise<void>;
} };

const SECRET = "seam-webhook-secret";
const ARTIFACTS = "/opt/cursor/artifacts";
const pngjs = requireFromServer("pngjs") as { PNG: any };
let stub: Server | null = null;
let inquiryId = "";
let frontPhoto: Buffer | null = null;

function idFrontPng(): Buffer {
  if (frontPhoto) return frontPhoto;
  const png = new pngjs.PNG({ width: 160, height: 100 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      png.data[i] = x < 48 ? 210 : 30;
      png.data[i + 1] = 80;
      png.data[i + 2] = x < 48 ? 40 : 160;
      png.data[i + 3] = 255;
    }
  }
  frontPhoto = pngjs.PNG.sync.write(png);
  return frontPhoto;
}

function inquiryBody(selfie: string) {
  return JSON.stringify({
    data: {
      id: inquiryId,
      attributes: {},
      relationships: {
        "inquiry-template": { data: { id: "itmpl_seamfixture" } },
        "inquiry-template-version": { data: { id: "itmplv_seam" } },
      },
    },
    included: [
      {
        type: "verification/government-id",
        id: "ver_gov_seam",
        attributes: {
          "name-first": "Ada",
          "name-last": "Fixture",
          "identification-number": "AB12348991",
          "id-class": "pp",
          "issuing-subdivision": "ON",
          "issuing-country": "CA",
          "expiration-date": "2030-01-15",
          "birthdate": "1990-04-02",
          "address-street-1": "1 King St",
          "address-city": "Toronto",
          "front-photo-url": "http://127.0.0.1:4199/id-front.png",
        },
      },
      { type: "verification/selfie", id: "ver_self_seam", attributes: { status: selfie } },
    ],
  });
}

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    const url = req.url || "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && url.startsWith("/id-front.png")) {
        const bytes = idFrontPng();
        res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
        res.end(bytes);
        return;
      }
      if (req.method === "POST" && url.includes("/inquiries") && !url.includes("one-time-link")) {
        inquiryId = `inq_${Date.now().toString(36)}`;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: inquiryId } }));
        return;
      }
      if (req.method === "GET" && url.includes("/inquiries/")) {
        const selfie = url.includes("incomplete") ? "failed" : "passed";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(inquiryBody(selfie));
        return;
      }
      if (url.includes("one-time-link")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ meta: { "one-time-link": "http://127.0.0.1:4199/sandbox-check" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Sandbox check</title><p>Sandbox ID check</p>");
    });
  });
  await new Promise<void>((resolve) => stub!.listen(4199, "127.0.0.1", () => resolve()));
});

test.afterAll(async () => {
  if (!stub) return;
  await new Promise<void>((resolve) => stub!.close(() => resolve()));
});

async function shot(page: Page, name: string) {
  if (process.env.PR2B_SHOTS !== "1") return;
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

async function themeShot(page: Page, stem: string) {
  if (process.env.PR2B_SHOTS !== "1") return;
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(value);
    }, theme);
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const shotPath = path.join(ARTIFACTS, `pr2-${stem}-${width}-${theme}.png`);
      if (!existsSync(shotPath)) await page.screenshot({ path: shotPath });
      if (width === 390) {
        await page.evaluate(() => {
          const flow = document.querySelector("[data-testid='id-check-flow']");
          if (flow) flow.scrollTop = flow.scrollHeight;
        });
        const scrolled = path.join(ARTIFACTS, `pr2-${stem}-390-${theme}-scrolled.png`);
        if (!existsSync(scrolled)) await page.screenshot({ path: scrolled });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("light");
  });
}

async function postWebhook(page: Page, id: string, outcome: "inquiry.approved" | "inquiry.failed") {
  const raw = JSON.stringify({
    data: {
      id: `evt_${id}_${outcome}`,
      attributes: {
        name: outcome,
        payload: { data: { id, attributes: { status: outcome === "inquiry.approved" ? "approved" : "failed" } } },
      },
    },
  });
  const stamp = Math.floor(Date.now() / 1000).toString();
  const mac = createHmac("sha256", SECRET).update(`${stamp}.${raw}`).digest("hex");
  const res = await page.request.post("/api/webhooks/idv/persona", {
    data: raw,
    headers: { "content-type": "application/json", "persona-signature": `t=${stamp},v1=${mac}` },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function enableChecks(request: APIRequestContext) {
  const login = await request.post("/api/auth/login", {
    data: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const saved = await request.put("/api/settings/idv", {
    data: {
      checksEnabled: true,
      apiKeyRef: "PERSONA_API_KEY",
      templateId: "itmpl_seamfixture",
      faceCropEnabled: true,
      privacyContact: "Privacy officer",
      privacyEmail: "privacy@yorkfx.example",
      privacyPhone: "4165550100",
      privacyPolicyUrl: "https://yorkfx.example/privacy",
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}

async function ensureTill(page: Page) {
  const open = await page.evaluate(async () => {
    const session = await fetch("/api/ledger/till-session").then((res) => res.json());
    if (session.session && session.session.status === "open") return "open";
    const book = await fetch("/api/ledger/till-balances").then((res) => res.json());
    if (!book.balances || !Object.keys(book.balances).length) {
      await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "20000.00", USD: "8000.00" } }),
      });
    }
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok || res.status === 409 ? "open" : await res.text();
  });
  expect(open, "till open").toBe("open");
}

/* The staged deal opens the shared till as the teller. A teller cannot
   close it, and a supervisor does not see that drawer's figures. Read
   the count while the teller still holds it, then close as the supervisor. */
async function readTillClose(page: Page): Promise<{ status: string; sessionId: string; balanceGeneration: string; balances: Record<string, string> }> {
  return page.evaluate(async () => {
    const heldResponse = await fetch("/api/ledger/till-balances");
    if (!heldResponse.ok) return { status: `balances ${heldResponse.status}`, sessionId: "", balanceGeneration: "0", balances: {} };
    const held = await heldResponse.json();
    const currentResponse = await fetch("/api/ledger/till-session");
    if (!currentResponse.ok) return { status: `session ${currentResponse.status}`, sessionId: "", balanceGeneration: "0", balances: {} };
    const current = await currentResponse.json();
    return {
      status: current.session?.status ?? "none",
      sessionId: current.session?.sessionId ?? "",
      balanceGeneration: String(held.balanceGeneration ?? "0"),
      balances: held.balances ?? {},
    };
  });
}

async function closeHeldTill(page: Page, snapshot: { status: string; sessionId: string; balanceGeneration: string; balances: Record<string, string> }): Promise<string> {
  return page.evaluate(async (shot) => {
    if (shot.status !== "open" || !shot.sessionId) return "closed";
    let counts: Record<string, string> = {};
    let generation = shot.balanceGeneration;
    const known = Object.entries(shot.balances);
    const heldNow = known.length ? null : await fetch("/api/ledger/till-balances").then((res) => res.json());
    const seen = known.length ? known : Object.entries((heldNow && heldNow.balances) || {});
    if (heldNow && heldNow.balanceGeneration != null) generation = String(heldNow.balanceGeneration);
    if (seen.length) {
      for (const [currency, amount] of seen) {
        const figure = Number(amount);
        counts[currency] = Number.isFinite(figure) ? figure.toFixed(2) : String(amount);
      }
    } else {
      /* A teller cannot put an opening count on the drawer, so the
         session can be open with no figures. The supervisor states
         them, then closes against that count. */
      const opened = await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "20000.00", USD: "8000.00" } }),
      });
      if (!opened.ok) return `opening ${opened.status} ${await opened.text()}`;
      const stated = await opened.json();
      generation = String(stated.balanceGeneration ?? "0");
      counts = { CAD: "20000.00", USD: "8000.00" };
    }
    const closed = await fetch(`/api/ledger/till-sessions/${shot.sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `idv-close-${Date.now()}`,
        counts,
        balanceGeneration: generation,
        note: "ID check seam close",
      }),
    });
    if (!closed.ok) return `close ${closed.status} ${await closed.text()}`;
    const body = await closed.json();
    return body.session?.status === "closed" ? "closed" : `still ${body.session?.status ?? "none"}`;
  }, snapshot);
}

async function openDeal(page: Page, name: string) {
  await page.locator('[data-app="clients"]').click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-app="ledger"]').click();
  await ensureTill(page);
  const button = page.getByRole("button", { name: /^New transaction$/i }).first();
  if (!(await button.isEnabled())) {
    await page.reload();
    await landOnDesktop(page);
  }
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await page.locator(".cd-tx-customer input").fill(name);
  await page.locator(".cd-money input").first().fill("100");
  await page.locator(".cd-money input").first().blur();
  const purpose = page.locator(".cd-tx-purpose");
  if (await purpose.count()) {
    await purpose.fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
  }
  await expect(page.locator(".cd-tx-go")).toBeEnabled({ timeout: 20_000 });
  await page.locator(".cd-tx-go").click();
  await expect(page.locator(".cd-tx-go")).toContainText(/Post frozen quote/, { timeout: 20_000 });
}

test("a staged deal runs the sandbox check, then the counter path", async ({ page, request }) => {
  test.setTimeout(180_000);
  await enableChecks(request);
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  try {
    await signInAtDesk(page, "m.costa");
    await page.setViewportSize({ width: 1280, height: 900 });
    const legalName = `Seam Id ${Date.now().toString(36)}`;
    const created = await page.evaluate(async (legalName) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, legalName);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const clientId = created.body.clientId as string;
    await page.reload();
    await landOnDesktop(page);
    await openDeal(page, legalName);
    await page.getByTestId("deal-check-id").click();
    await expect(page.getByTestId("id-check-chooser")).toBeVisible();
    await expect(page.getByRole("button", { name: /ID, selfie and database/ })).toBeDisabled();
    await expect(page.getByText("Coming later.")).toBeVisible();
    await expect(page.locator(".cd-tx-go")).toBeHidden();
    await themeShot(page, "chooser");
    await page.getByTestId("id-check-chooser").locator("button").filter({ hasText: /^ID and selfie/ }).click();
    await expect(page.getByTestId("id-check-notice")).toContainText("Your ID details are kept for at least 5 years because the law requires it.");
    await expect(page.getByTestId("id-check-notice")).toContainText("United States");
    await themeShot(page, "notice");
    await page.getByRole("button", { name: "Continue" }).click();
    const agree = page.getByRole("button", { name: "I agree" });
    await expect(agree).toBeDisabled();
    await expect(page.getByTestId("id-check-agree-box")).not.toBeChecked();
    await expect(page.getByText("I agree to the face match.", { exact: true })).toHaveCount(1);
    await themeShot(page, "consent");
    const started = page.waitForResponse((res) => res.url().includes("/api/idv/start-check") && res.request().method() === "POST");
    await page.getByTestId("id-check-agree-box").check();
    await agree.click();
    const start = await started;
    expect(start.ok(), await start.text()).toBeTruthy();
    const providerRef = (await start.json()).providerRef as string;
    expect(providerRef).toBeTruthy();
    await expect(page.getByTestId("id-check-link-url")).toContainText("sandbox-check");
    await themeShot(page, "link");
    await postWebhook(page, providerRef, "inquiry.approved");
    await expect(page.getByTestId("id-check-done")).toContainText("ID checked", { timeout: 20_000 });
    await expect(page.getByTestId("id-check-done")).toContainText("ID and selfie, Persona");
    await expect(page.getByTestId("id-check-done")).toContainText("•••• 8991");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("deal-id-link")).toContainText("ID and selfie, Persona");
    await themeShot(page, "deal-link");
    const linked = await page.evaluate(async (id) => {
      const res = await fetch(`/api/idv/clients/${id}/checks`);
      return res.json();
    }, clientId);
    const record = (linked.records as Array<{ deals?: string[]; maskedNumber?: string; line?: string; photoOnFile?: boolean }>)[0];
    const linkedStanding = linked as { standing: { onFile: boolean; chip: string; line: string } };
    expect(record.maskedNumber).toBe("•••• 8991");
    expect(record.photoOnFile).toBe(true);
    expect(linkedStanding.standing.onFile).toBe(true);
    expect(linkedStanding.standing.chip).toBe("ID on file");
    expect(linkedStanding.standing.line).toContain("ID and selfie");
    expect(linkedStanding.standing.line).toContain("•••• 8991");
    expect(record.deals && record.deals.length).toBeGreaterThan(0);
    expect(JSON.stringify(linked)).not.toContain("AB12348991");

    await page.getByTestId("deal-check-id").click();
    await page.getByTestId("id-check-chooser").locator("button").filter({ hasText: /^ID and selfie/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "No thanks, check my ID at the counter" }).click();
    await expect(page.getByTestId("id-check-no-thanks")).toContainText("Customer chose the counter check. Inspect the original ID.");
    await themeShot(page, "no-thanks");
    await page.getByRole("button", { name: "Enter the ID" }).click();
    await expect(page.getByTestId("id-check-in-person")).toBeVisible();
    await themeShot(page, "in-person");
    await page.route("**/api/idv/checks/in-person", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "id_number_key_unavailable", message: "ID number storage is not set up for this shop yet." }),
    }));
    await page.getByLabel("Name on the ID").fill("Ada Fixture");
    await page.getByLabel("Document type").selectOption({ label: "Passport" });
    await page.getByLabel("Document number").fill("PP12348991");
    await page.getByLabel("Issuer").fill("ON");
    await page.getByLabel("Country").fill("CA");
    await page.getByRole("checkbox", { name: /inspected the original ID/i }).check();
    await page.getByRole("button", { name: "Save the ID record" }).click();
    await expect(page.getByTestId("id-check-storage")).toHaveText("ID number storage is not set up for this shop yet.");
    await themeShot(page, "storage");
    await page.unroute("**/api/idv/checks/in-person");
    await page.getByTestId("id-check-flow").getByRole("button", { name: "Close" }).click();
    await page.locator(".cd-tx-x").click();

    await page.locator('[data-app="clients"]').click();
    await page.getByText(legalName, { exact: true }).click();
    const file = page.getByTestId("identity-check");
    await expect(file).toContainText("Check passed");
    await expect(file).toContainText(/ID checked /);
    await expect(file).toContainText("ID and selfie, Persona");
    await expect(file.getByTestId("id-check-masked")).toHaveText("•••• 8991");
    await expect(file.getByTestId("id-check-reveal-open")).toHaveCount(0);
    await expect(file).not.toContainText("Approved");
    const profile = page.locator(".client-file");
    await expect(page.getByTestId("client-standing")).toHaveText("ID on file");
    await expect(page.getByTestId("client-standing")).not.toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).toContainText("Identified");
    await expect(page.getByTestId("client-where")).toContainText("ID and selfie");
    await expect(page.getByTestId("client-where")).toContainText("•••• 8991");
    await expect(page.getByTestId("client-where")).not.toContainText("Not identified");
    await expect(profile.getByText("KYC / ID gap")).toHaveCount(0);
    await expect(file.getByTestId("id-check-photo-line")).toHaveText("Photo from ID, for comparison by eye");
    await expect(file).not.toContainText("No photo on file");
    await file.getByRole("button", { name: "Show the photo" }).click();
    const photo = file.getByTestId("id-check-photo");
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute("width", "96");
    await expect(photo).toHaveAttribute("height", "96");
    const views = await db.query("SELECT reason FROM idv_crop_views WHERE client_id = $1", [clientId]);
    expect(views.rows.some((row) => row.reason === "eye_comparison")).toBe(true);
    await themeShot(page, "badge-passed");
    await themeShot(page, "masked-teller");

    const tillClose = await readTillClose(page);
    await signInAtDesk(page, "a.singh");
    expect(await closeHeldTill(page, tillClose)).toBe("closed");
    await page.locator('[data-app="clients"]').click();
    await page.getByText(legalName, { exact: true }).click();
    await page.getByTestId("id-check-reveal-open").click();
    await themeShot(page, "reveal");
    await page.getByTestId("id-check-reveal-reason").selectOption("fintrac_request");
    await page.getByTestId("id-check-reveal").getByRole("button", { name: "Show number" }).click();
    await expect(page.getByTestId("id-check-revealed")).toHaveText("AB12348991");
    await expect(page.getByTestId("id-check-audit")).toContainText("FINTRAC request");
    await expect(page.getByTestId("id-check-audit")).not.toContainText("AB12348991");
    await themeShot(page, "audit");
  } finally {
    await request.put("/api/settings/idv", { data: { checksEnabled: false } }).catch(() => {});
    await db.end();
  }
});

test("counter screens for the other badge states", async ({ page, request }) => {
  test.skip(process.env.PR2B_SHOTS !== "1", "screenshot pass");
  test.setTimeout(180_000);
  await enableChecks(request);
  await signInAtDesk(page, "m.costa");
  const made = async (name: string) => {
    const created = await page.evaluate(async (legalName) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, name);
    expect(created.status).toBe(201);
    return created.body.clientId as string;
  };
  const none = await made("No Check Client");
  const progress = await made("Progress Check Client");
  const review = await made("Review Check Client");
  const declined = await made("Declined Check Client");
  const incomplete = await made("Incomplete Check Client");
  const advice = await made("Advice Check Client");
  const due = await made("Due Check Client");
  const returning = await made("Returning Check Client");
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  const insert = async (clientId: string, result: string, method: string, yearsAgo: number) => {
    await db.query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id, verified_at, document_number_last4, name_on_id)
       VALUES ($1, 'tnt-yorkfx', 'le-yorkfx-canada', 'br-yorkville', $2, '1', $3, $4, 'm.costa', now() - ($5 || ' years')::interval, '8991', 'Fixture Person')`,
      [`idc_${clientId}_${result}`, clientId, method, result, String(yearsAgo)],
    );
  };
  try {
    await db.query(
      `INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, status, client_id)
       VALUES ($1, 'le-yorkfx-canada', 'br-yorkville', 'm.costa', 'persona', $2, 'in progress', $3)`,
      [`ref_${progress}`, `inq_${progress}`, progress],
    );
    await insert(review, "needs_review", "id_and_selfie", 0);
    await insert(declined, "declined", "id_and_selfie", 0);
    await insert(incomplete, "method_not_completed", "id_and_selfie", 0);
    await insert(advice, "pass", "in_person", 4);
    await insert(due, "pass", "in_person", 6);
    const inPerson = await page.evaluate(async (clientId) => {
      const res = await fetch("/api/idv/checks/in-person", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId, nameOnId: "Returning Fixture", documentType: "Passport", documentNumber: "PP99818991",
          issuingJurisdiction: "ON", issuingCountry: "CA", expiryDate: "2030-01-15", attested: true,
        }),
      });
      return { status: res.status, body: await res.text() };
    }, returning);
    expect(inPerson.status, inPerson.body).toBe(200);

    const openFile = async (name: string) => {
      const flow = page.getByTestId("id-check-flow");
      if (await flow.isVisible().catch(() => false)) await flow.getByRole("button", { name: "Close" }).click();
      const fileHead = page.locator(".client-file-actions");
      if (await fileHead.isVisible().catch(() => false)) await fileHead.locator("button").last().click();
      await page.locator('[data-app="clients"]').click();
      await page.getByText(name, { exact: true }).click();
      await expect(page.getByTestId("identity-check")).toBeVisible();
    };
    const startCheck = async () => {
      const button = page.getByTestId("id-check-start");
      await expect(button).toHaveText(/Check ID/, { timeout: 20_000 });
      await page.evaluate(() => {
        const node = document.querySelector("[data-testid='id-check-start']");
        if (node instanceof HTMLButtonElement) node.click();
      });
    };
    await openFile("No Check Client");
    await expect(page.getByTestId("id-check-badge")).toContainText("No ID check on file");
    await themeShot(page, "badge-none");
    await startCheck();
    await expect(page.getByTestId("id-check-chooser")).toBeVisible();
    await page.getByRole("button", { name: "Returning client" }).click();
    await expect(page.getByTestId("id-check-returning-blocked")).toBeVisible();
    await themeShot(page, "returning-blocked");
    await page.getByRole("button", { name: "Close" }).click();

    await openFile("Progress Check Client");
    await expect(page.getByTestId("id-check-badge")).toContainText("ID check in progress");
    await themeShot(page, "badge-progress");
    await openFile("Review Check Client");
    await expect(page.getByTestId("id-check-badge")).toContainText("This needs review. Your compliance officer will review this.");
    await themeShot(page, "badge-review");
    await openFile("Declined Check Client");
    await expect(page.getByTestId("id-check-badge")).toContainText("Check not passed. Check the ID at the counter.");
    await themeShot(page, "badge-declined");
    await openFile("Incomplete Check Client");
    await expect(page.getByTestId("id-check-badge")).toContainText("Method not completed. Check the ID at the counter.");
    await themeShot(page, "badge-incomplete");

    await openFile("Advice Check Client");
    await expect(page.getByTestId("id-check-advice")).toContainText("A new ID and selfie check is advised.");
    await themeShot(page, "badge-advice");
    await expect(page.getByTestId("id-check-badge")).toContainText("photo ID, in person");
    await themeShot(page, "badge-in-person");
    await openFile("Due Check Client");
    await expect(page.getByTestId("id-check-due")).toContainText("A new full ID check is needed.");
    await themeShot(page, "badge-due");
    await startCheck();
    await page.getByRole("button", { name: "Returning client" }).click();
    await expect(page.getByTestId("id-check-returning-blocked")).toContainText("A new full ID check is needed.");
    await page.getByRole("button", { name: "Close" }).click();

    await openFile("Returning Check Client");
    await startCheck();
    await page.getByRole("button", { name: "Returning client" }).click();
    await expect(page.getByTestId("id-check-no-photo")).toContainText("No photo on file");
    await themeShot(page, "returning");
    await page.getByRole("button", { name: "No", exact: true }).click();
    await page.getByRole("checkbox", { name: /no doubts/i }).check();
    await page.getByRole("button", { name: "Record returning client" }).click();
    await expect(page.getByTestId("id-check-done")).toContainText("Returning client");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("identity-check")).toContainText("Returning client");
    await themeShot(page, "badge-returning");

    await db.query("UPDATE branches SET province = 'QC' WHERE id = 'br-yorkville'");
    await page.reload();
    await landOnDesktop(page);
    await openFile("No Check Client");
    await startCheck();
    await expect(page.getByTestId("id-check-quebec")).toContainText("Face match is off for this branch. Inspect the original ID.");
    await themeShot(page, "quebec");
    await page.getByRole("button", { name: "Close" }).click();

    await signInAtDesk(page, "j.masri");
    await page.locator('[data-app="settings"]').click();
    await page.getByRole("button", { name: "Clients · KYC" }).click();
    await expect(page.getByTestId("id-check-settings")).toBeVisible({ timeout: 20_000 });
    await themeShot(page, "settings-crop");
  } finally {
    await db.query("UPDATE branches SET province = 'ON' WHERE id = 'br-yorkville'");
    await request.put("/api/settings/idv", { data: { checksEnabled: false } }).catch(() => {});
    await db.end();
  }
});
