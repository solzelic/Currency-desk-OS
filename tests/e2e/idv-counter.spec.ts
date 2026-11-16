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
      const dx = x - 58;
      const dy = y - 42;
      const head = (dx * dx) / (26 * 26) + (dy * dy) / (32 * 32) <= 1;
      const tone = head ? 150 : 226;
      png.data[i] = tone;
      png.data[i + 1] = tone - (head ? 6 : 2);
      png.data[i + 2] = tone - (head ? 10 : 4);
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
        res.end(JSON.stringify({ meta: { "one-time-link": "https://inquiry.withpersona.com/sandbox-check" } }));
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

async function dismissTour(page: Page) {
  await page.evaluate(() => {
    const skip = document.querySelector(".cdos-tour-skip");
    if (skip instanceof HTMLButtonElement) skip.click();
  });
  await expect(page.locator(".cdos-tour")).toHaveCount(0);
}

async function shot(page: Page, name: string) {
  if (process.env.PR2B_SHOTS !== "1") return;
  await dismissTour(page);
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
}

async function themeShot(page: Page, stem: string) {
  if (process.env.PR2B_SHOTS !== "1") return;
  await dismissTour(page);
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
          if (flow && flow.scrollHeight > flow.clientHeight + 1) {
            flow.scrollTop = flow.scrollHeight;
            return;
          }
          const scroller = document.querySelector(".client-file .overflow-auto");
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
      privacyPhone: "416-555-0100",
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
  test.setTimeout(300_000);
  await enableChecks(request);
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  try {
    await signInAtDesk(page, "m.costa");
    await page.setViewportSize({ width: 1280, height: 900 });
    const legalName = "Maria Santos";
    await db.query("UPDATE desk_clients SET display_name = display_name || ' earlier' WHERE display_name = 'Maria Santos'");
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
    await expect(page.getByTestId("id-check-primary")).toContainText("ID and selfie");
    await expect(page.getByText("in the sandbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /ID, selfie and database/ })).toHaveCount(0);
    await expect(page.getByText("More options")).toBeVisible();
    await expect(page.getByRole("button", { name: "Returning client" })).toHaveCount(0);
    await expect(page.locator(".cd-tx-go")).toBeHidden();
    await themeShot(page, "chooser");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("light");
    });
    await page.getByRole("button", { name: "More options" }).click();
    await expect(page.getByRole("button", { name: "More options" })).toHaveAttribute("aria-expanded", "true");
    if (process.env.PR2B_SHOTS === "1") {
      await page.screenshot({ path: path.join(ARTIFACTS, "pr2-chooser-1280-light.png") });
    }
    await page.getByTestId("id-check-chooser").locator("button").filter({ hasText: /^ID and selfie/ }).click();
    await expect(page.getByTestId("id-check-notice")).toContainText("Your ID details are kept for at least 5 years because the law requires it.");
    await expect(page.getByTestId("id-check-notice")).toContainText("United States");
    await expect(page.getByTestId("id-check-notice")).toContainText("416-555-0100");
    await expect(page.getByTestId("id-check-notice")).not.toContainText("https://");
    await expect(page.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", /^https:\/\//);
    await expect(page.getByRole("link", { name: "Persona's privacy notice" })).toHaveAttribute("href", /^https:\/\//);
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
    await expect(page.getByTestId("id-check-link-url")).toHaveAttribute("href", "https://inquiry.withpersona.com/sandbox-check");
    await themeShot(page, "link");
    await postWebhook(page, providerRef, "inquiry.approved");
    await expect(page.getByTestId("id-check-done")).toContainText("ID checked", { timeout: 20_000 });
    await expect(page.getByTestId("id-check-done")).toContainText("ID and selfie, Persona");
    await expect(page.getByTestId("id-check-done")).toContainText("•••• 8991");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("deal-id-link")).toContainText("ID and selfie, Persona");
    await expect(page.getByTestId("deal-id-badge")).toContainText("ID on file", { timeout: 20_000 });
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
    expect(linkedStanding.standing.line).not.toContain("8991");
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
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const attest = await page.locator(".id-check-attest").evaluate((el) => {
        const label = el.getBoundingClientRect();
        const card = el.closest("[data-testid='id-check-flow']")?.getBoundingClientRect();
        const text = el.querySelector("span");
        const box = text?.getBoundingClientRect();
        return {
          words: text?.textContent || "",
          past: card && box ? box.right > card.right + 1 : true,
          wraps: text ? text.getClientRects().length > 1 || (box ? box.width < (text.textContent || "").length * 6 : false) : false,
          fits: text ? text.scrollWidth <= text.clientWidth : false,
          labelWide: card ? label.right <= card.right + 1 : false,
        };
      });
      expect(attest.words, `${width}`).toContain("face matched");
      expect(attest.past, `${width}`).toBe(false);
      expect(attest.fits, `${width}`).toBe(true);
      expect(attest.labelWide, `${width}`).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
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
    await expect(page.getByTestId("client-where")).not.toContainText("8991");
    await expect(page.getByTestId("client-where")).not.toContainText("Not identified");
    await expect(profile.getByText("KYC / ID gap")).toHaveCount(0);
    await expect(file.getByTestId("id-check-photo-line")).toHaveText("Photo from ID, for comparison by eye");
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      const where = await page.getByTestId("client-where-line").evaluate((el) => {
        const line = el.getBoundingClientRect();
        const card = el.closest(".client-file")?.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          text: el.textContent || "",
          whiteSpace: style.whiteSpace,
          pastCard: card ? line.right > card.right + 1 : true,
        };
      });
      expect(where.text, `${width}`).toContain("Persona");
      expect(where.whiteSpace, `${width}`).not.toBe("nowrap");
      expect(where.pastCard, `${width} ${where.text}`).toBe(false);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(file).not.toContainText("No photo on file");
    await file.getByRole("button", { name: "Show the photo" }).click();
    const photo = file.getByTestId("id-check-photo");
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute("width", "96");
    await expect(photo).toHaveAttribute("height", "96");
    const views = await db.query("SELECT reason FROM idv_crop_views WHERE client_id = $1", [clientId]);
    expect(views.rows.some((row) => row.reason === "eye_comparison")).toBe(true);
    await expect(file.getByTestId("id-check-reveal-open")).toHaveCount(0);
    await themeShot(page, "badge-passed");
    await themeShot(page, "masked-teller");
    await themeShot(page, "file-teller");

    const otherName = `Other File ${Date.now()}`;
    const other = await page.evaluate(async (legalName) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, otherName);
    expect(other.status).toBe(201);
    await page.locator(".client-file-actions button").last().click();
    await page.reload();
    await landOnDesktop(page);
    await page.locator('[data-app="clients"]').click();
    await page.getByText(otherName, { exact: true }).click();
    await expect(page.getByTestId("identity-check")).toBeVisible();
    await expect(page.getByTestId("id-check-photo")).toHaveCount(0);
    await expect(page.getByTestId("id-check-revealed")).toHaveCount(0);
    await expect(page.getByTestId("identity-check")).not.toContainText("8991");
    await page.locator(".client-file-actions button").last().click();

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
    const openPassed = async () => {
      await page.locator('[data-app="clients"]').click();
      await page.getByText(legalName, { exact: true }).click();
      await expect(page.getByTestId("identity-check")).toBeVisible();
      await expect(page.getByRole("button", { name: "Show number" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Show the photo" })).toBeVisible();
    };
    await signInAtDesk(page, "r.haddad");
    await landOnDesktop(page);
    await openPassed();
    await themeShot(page, "role-manager");
    await themeShot(page, "file-manager");
    await page.locator(".client-file-actions button").last().click();
    await signInAtDesk(page, "j.masri");
    await landOnDesktop(page);
    await openPassed();
    await themeShot(page, "role-owner");
    await themeShot(page, "file-owner");
    await page.locator(".client-file-actions button").last().click();
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
  const mark = String(Date.now());
  const noneName = `No Check Client ${mark}`;
  const progressName = `Progress Check Client ${mark}`;
  const reviewName = `Review Check Client ${mark}`;
  const declinedName = `Declined Check Client ${mark}`;
  const incompleteName = `Incomplete Check Client ${mark}`;
  const adviceName = `Advice Check Client ${mark}`;
  const dueName = `Due Check Client ${mark}`;
  const returningName = `Returning Check Client ${mark}`;
  const none = await made(noneName);
  const progress = await made(progressName);
  const review = await made(reviewName);
  const declined = await made(declinedName);
  const incomplete = await made(incompleteName);
  const advice = await made(adviceName);
  const due = await made(dueName);
  const returning = await made(returningName);
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  const insert = async (clientId: string, result: string, method: string, yearsAgo: number) => {
    const person = method === "in_person";
    await db.query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         inspector_staff_id, verified_at, document_type, document_number_ciphertext, document_number_last4,
         number_unavailable, issuing_jurisdiction, issuing_country, expiry_date, name_on_id)
       VALUES ($1, 'tnt-yorkfx', 'le-yorkfx-canada', 'br-yorkville', $2, $3, $4, $5, 'm.costa',
         $6, now() - ($7 || ' years')::interval, $8, $9, '8991', false, $10, $11, $12, 'Fixture Person')`,
      [
        `idc_${clientId}_${result}`, clientId, person ? "1" : "3", method, result,
        person ? "m.costa" : null, String(yearsAgo),
        person ? "Passport" : null, person ? "aes-256-gcm$seam" : null,
        person ? "Canada" : null, person ? "CA" : null, person ? "2030-04-01" : null,
      ],
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
    await openFile(noneName);
    await expect(page.getByTestId("id-check-badge")).toContainText("No ID check on file");
    await themeShot(page, "badge-none");
    await startCheck();
    await expect(page.getByTestId("id-check-chooser")).toBeVisible();
    await expect(page.getByRole("button", { name: "Returning client" })).toHaveCount(0);
    await page.getByTestId("id-check-flow").getByRole("button", { name: "Close" }).click();

    await openFile(progressName);
    await expect(page.getByTestId("id-check-badge")).toContainText("ID check in progress");
    await themeShot(page, "badge-progress");
    await openFile(reviewName);
    await expect(page.getByTestId("id-check-badge")).toContainText("Under review since");
    await themeShot(page, "badge-review");
    await openFile(declinedName);
    await expect(page.getByTestId("id-check-badge")).toContainText("Not passed");
    await themeShot(page, "badge-declined");
    await openFile(incompleteName);
    await expect(page.getByTestId("id-check-badge")).toContainText("Method not completed. Check the ID at the counter.");
    await themeShot(page, "badge-incomplete");
    await startCheck();
    await page.getByTestId("id-check-primary").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("id-check-agree-box").check();
    const failedStart = page.waitForResponse((res) => res.url().includes("/api/idv/start-check") && res.request().method() === "POST");
    await page.getByRole("button", { name: "I agree" }).click();
    const failed = await failedStart;
    expect(failed.ok(), await failed.text()).toBeTruthy();
    await postWebhook(page, (await failed.json()).providerRef as string, "inquiry.failed");
    await expect(page.getByTestId("id-check-incomplete")).toBeVisible({ timeout: 20_000 });
    await themeShot(page, "method-not-completed");
    await page.getByTestId("id-check-flow").getByRole("button", { name: "Close" }).click();

    await openFile(adviceName);
    await expect(page.getByTestId("client-standing")).toContainText("ID on file");
    await expect(page.getByTestId("client-where")).toContainText("ID seen in person by m.costa, Passport, expires 1 Apr 2030, checked");
    await expect(page.getByTestId("id-check-advice")).toContainText("A new ID and selfie check is advised.");
    await expect(page.getByTestId("id-check-badge")).toContainText("photo ID, in person");
    await themeShot(page, "badge-advice");
    await openFile(returningName);
    await expect(page.getByTestId("client-standing")).toContainText("ID on file");
    await expect(page.getByTestId("client-where")).toContainText("ID seen in person by m.costa, Passport, expires 15 Jan 2030, checked");
    await expect(page.getByTestId("id-check-advice")).toHaveCount(0);
    await themeShot(page, "badge-in-person");
    await openFile(dueName);
    await expect(page.getByTestId("id-check-due")).toContainText("A new full ID check is needed.");
    await themeShot(page, "badge-due");
    await startCheck();
    await page.getByText("More options").click();
    await page.getByRole("button", { name: "Returning client" }).click();
    await expect(page.getByTestId("id-check-returning-blocked")).toContainText("A new full ID check is needed.");
    await themeShot(page, "returning-blocked");
    await page.getByTestId("id-check-flow").getByRole("button", { name: "Close" }).click();

    await openFile(adviceName);
    await startCheck();
    await page.getByText("More options").click();
    await page.getByRole("button", { name: "Returning client" }).click();
    await expect(page.getByTestId("id-check-no-photo")).toContainText("No photo on file");
    await expect(page.getByTestId("id-check-returning")).toContainText("Is this person, or a family member or close associate, a politically exposed person or the head of an international organization?");
    await expect(page.getByRole("button", { name: "Not asked" })).toBeVisible();
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
    await openFile(noneName);
    await startCheck();
    await expect(page.getByTestId("id-check-quebec")).toContainText("Face match is off for this branch. Inspect the original ID.");
    await themeShot(page, "quebec");
    await page.getByTestId("id-check-flow").getByRole("button", { name: "Close" }).click();

    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await expect(page.locator(".cdos-tour")).toHaveCount(0);
    await page.locator('[data-app="settings"]').click();
    await page.getByRole("button", { name: "Clients · KYC" }).click();
    await expect(page.getByTestId("id-check-settings")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Privacy phone")).toHaveValue("416-555-0100");
    const settingsWin = page.locator(".win").filter({ has: page.getByTestId("id-check-settings") });
    await page.locator(".win").evaluateAll((nodes) => {
      nodes.forEach((node) => {
        if (node.querySelector("[data-testid='id-check-settings']")) return;
        const close = node.querySelector(".win-close");
        if (close instanceof HTMLButtonElement) close.click();
      });
    });
    await expect(page.locator(".win")).toHaveCount(1);
    if (process.env.PR2B_SHOTS === "1") {
      await dismissTour(page);
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => {
          (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(value);
        }, theme);
        for (const width of [1280, 390] as const) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          await dismissTour(page);
          await settingsWin.evaluate((el) => {
            const bar = el.querySelector(".win-bar");
            if (!bar) return;
            const zoom = () => bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
            if (el.classList.contains("max")) zoom();
            zoom();
          });
          await expect(settingsWin).toHaveClass(/max/);
          const shotPath = path.join(ARTIFACTS, `pr2-settings-crop-${width}-${theme}.png`);
          if (!existsSync(shotPath)) await page.screenshot({ path: shotPath });
          if (width === 390) {
            await settingsWin.locator(".win-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
            const scrolled = path.join(ARTIFACTS, `pr2-settings-crop-390-${theme}-scrolled.png`);
            if (!existsSync(scrolled)) await page.screenshot({ path: scrolled });
          }
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => {
        (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("light");
      });
    }
  } finally {
    await db.query("UPDATE branches SET province = 'ON' WHERE id = 'br-yorkville'");
    await request.put("/api/settings/idv", { data: { checksEnabled: false } }).catch(() => {});
    await db.end();
  }
});

test("settings is one opaque window and the privacy phone is formatted", async ({ page, request }) => {
  test.skip(process.env.PR2B_SHOTS !== "1", "screenshot pass");
  test.setTimeout(120_000);
  await enableChecks(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAtDesk(page, "j.masri");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator(".win .win-close").evaluateAll((nodes) => {
    nodes.forEach((node) => { if (node instanceof HTMLButtonElement) node.click(); });
  });
  await page.locator('[data-app="settings"]').click();
  await page.getByRole("button", { name: "Clients · KYC" }).click();
  await expect(page.getByTestId("id-check-settings")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Privacy phone")).toHaveValue("416-555-0100");
  const settingsWin = page.locator(".win").filter({ has: page.getByTestId("id-check-settings") });
  await expect(settingsWin).toHaveCount(1);
  await dismissTour(page);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(value);
    }, theme);
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await dismissTour(page);
      await settingsWin.evaluate((el) => {
        const bar = el.querySelector(".win-bar");
        if (!bar) return;
        const zoom = () => bar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        if (el.classList.contains("max")) zoom();
        zoom();
      });
      await expect(settingsWin).toHaveClass(/max/);
      const shotPath = path.join(ARTIFACTS, `pr2-settings-crop-${width}-${theme}.png`);
      if (!existsSync(shotPath)) await page.screenshot({ path: shotPath });
      if (width === 390) {
        await settingsWin.locator(".win-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await page.screenshot({ path: path.join(ARTIFACTS, `pr2-settings-crop-390-${theme}-scrolled.png`) });
      }
    }
  }
});

test("the notice comes back when the crop sentence changes before I agree", async ({ page, request }) => {
  test.setTimeout(120_000);
  await enableChecks(request);
  try {
    await signInAtDesk(page, "m.costa");
    const name = `Crop Flip ${Date.now()}`;
    const created = await page.evaluate(async (legalName) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, name);
    expect(created.status).toBe(201);
    await page.locator('[data-app="clients"]').click();
    await page.getByText(name, { exact: true }).click();
    await page.getByTestId("id-check-start").click();
    await page.getByTestId("id-check-primary").click();
    await expect(page.getByTestId("id-check-notice")).toContainText("small photo of your face");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByTestId("id-check-agree-box").check();
    const flipped = await request.put("/api/settings/idv", {
      data: {
        checksEnabled: true,
        apiKeyRef: "PERSONA_API_KEY",
        templateId: "itmpl_seamfixture",
        faceCropEnabled: false,
        privacyContact: "Privacy officer",
        privacyEmail: "privacy@yorkfx.example",
        privacyPhone: "416-555-0100",
        privacyPolicyUrl: "https://yorkfx.example/privacy",
      },
    });
    expect(flipped.ok(), await flipped.text()).toBeTruthy();
    await page.getByRole("button", { name: "I agree" }).click();
    await expect(page.getByTestId("id-check-notice")).toBeVisible();
    await expect(page.getByTestId("id-check-notice")).not.toContainText("small photo of your face");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("id-check-agree-box")).not.toBeChecked();
  } finally {
    await request.put("/api/settings/idv", { data: { checksEnabled: false, faceCropEnabled: true } }).catch(() => {});
  }
});

test("the notice leaves out the photo sentence when the crop is off", async ({ page, request }) => {
  test.setTimeout(120_000);
  await enableChecks(request);
  const saved = await request.put("/api/settings/idv", {
    data: {
      checksEnabled: true,
      apiKeyRef: "PERSONA_API_KEY",
      templateId: "itmpl_seamfixture",
      faceCropEnabled: false,
      privacyContact: "Privacy officer",
      privacyEmail: "privacy@yorkfx.example",
      privacyPhone: "416-555-0100",
      privacyPolicyUrl: "https://yorkfx.example/privacy",
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  try {
    await signInAtDesk(page, "m.costa");
    const name = `Crop Off ${Date.now()}`;
    const created = await page.evaluate(async (legalName) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, name);
    expect(created.status).toBe(201);
    await page.locator('[data-app="clients"]').click();
    await page.getByText(name, { exact: true }).click();
    await expect(page.getByTestId("identity-check")).not.toContainText("Show the photo");
    await expect(page.getByTestId("id-check-photo")).toHaveCount(0);
    await page.getByTestId("id-check-start").click();
    await page.getByTestId("id-check-primary").click();
    await expect(page.getByTestId("id-check-notice")).toBeVisible();
    await expect(page.getByTestId("id-check-notice")).not.toContainText("small photo of your face");
  } finally {
    await request.put("/api/settings/idv", { data: { checksEnabled: false, faceCropEnabled: true } }).catch(() => {});
  }
});

test("ID on file agrees on the chip, the file, the deal, the flags, and Needs attention", async ({ page, request }) => {
  test.setTimeout(180_000);
  await enableChecks(request);
  const db = new Client({ connectionString: process.env.SEAM_DATABASE_URL });
  await db.connect();
  let tillClose: { status: string; sessionId: string; balanceGeneration: string; balances: Record<string, string> } | null = null;
  const stamp = Date.now();
  const names = {
    pass: `Agree Pass ${stamp}`,
    unavailable: `Agree Unavailable ${stamp}`,
    expired: `Agree Expired ${stamp}`,
    old: `Agree Old ${stamp}`,
    typed: `Agree Typed ${stamp}`,
    noStaff: `Agree No Staff ${stamp}`,
    noDate: `Agree No Date ${stamp}`,
    typedExpired: `Agree Typed Expired ${stamp}`,
    otherShop: `Agree Other Shop ${stamp}`,
    typedOld: `Agree Typed Old ${stamp}`,
    typedUnavailable: `Agree Typed Unavailable ${stamp}`,
  };
  const made = async (legalName: string) => {
    const created = await page.evaluate(async (name) => {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ legalName: name, kind: "individual" }),
      });
      return { status: res.status, body: await res.json() };
    }, legalName);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.clientId as string;
  };
  try {
    await signInAtDesk(page, "m.costa");
    const beforeStanding = await page.evaluate(() => {
      const read = (window as unknown as { CDOS: { idFileKyc: (rec: unknown) => string } }).CDOS.idFileKyc;
      return {
        bare: read({ idType: "Passport", idNum: "AB1234", idExpiry: "2030-04-01" }),
        on: read({ idStanding: { onFile: true, chip: "ID on file" } }),
        gap: read({ idStanding: { onFile: false, chip: "Missing ID" }, idType: "Passport", idNum: "AB1234" }),
      };
    });
    expect(beforeStanding.bare).toBe("Checking ID");
    expect(beforeStanding.on).toBe("ok");
    expect(beforeStanding.gap).toBe("missing ID");
    const ids = {
      pass: await made(names.pass),
      unavailable: await made(names.unavailable),
      expired: await made(names.expired),
      old: await made(names.old),
      typed: await made(names.typed),
      noStaff: await made(names.noStaff),
      noDate: await made(names.noDate),
      typedExpired: await made(names.typedExpired),
      otherShop: await made(names.otherShop),
      typedOld: await made(names.typedOld),
      typedUnavailable: await made(names.typedUnavailable),
    };
    const insert = async (clientId: string, extra: string) => {
      await db.query(
        `INSERT INTO idv_check_records
          (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
           verified_at, document_number_last4, number_unavailable, expiry_date, name_on_id)
         VALUES ($1,'tnt-yorkfx','le-yorkfx-canada','br-yorkville',$2,'3','id_and_selfie','pass','m.costa', ${extra})`,
        [`idc_agree_${clientId}`, clientId],
      );
    };
    await insert(ids.pass, "now(), '3333', false, '2030-01-02', 'Agree Pass'");
    await insert(ids.unavailable, "now(), NULL, true, '2030-01-02', 'Agree Unavailable'");
    await insert(ids.expired, "now(), '1111', false, '2020-01-01', 'Agree Expired'");
    await insert(ids.old, "now() - interval '6 years', '2222', false, '2030-01-02', 'Agree Old'");
    const typedRow = async (clientId: string, extra: string) => {
      await db.query(
        `INSERT INTO idv_check_records
          (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
           inspector_staff_id, verified_at, document_type, document_number_ciphertext, document_number_last4,
           number_unavailable, issuing_jurisdiction, issuing_country, expiry_date, name_on_id)
         VALUES ($1,'tnt-yorkfx','le-yorkfx-canada','br-yorkville',$2,'1','in_person','pass','m.costa', ${extra})`,
        [`idc_typed_${clientId}`, clientId],
      );
    };
    const full = "'m.costa', now(), 'Passport', 'aes-256-gcm$seam', '4444', false, 'Canada', 'CA'";
    await typedRow(ids.typed, `${full}, '2030-04-01', 'Typed Pass'`);
    await typedRow(ids.noStaff, `NULL, now(), 'Passport', 'aes-256-gcm$seam', '5555', false, 'Canada', 'CA', '2030-04-01', 'Typed Staff'`);
    await db.query(
      `INSERT INTO desk_client_identity_documents
        (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, is_primary)
       VALUES ($1, $2, 'tnt-yorkfx', 'le-yorkfx-canada', 'Passport', 'PP1000', true)`,
      [`doc_${ids.noDate}`, ids.noDate],
    );
    await typedRow(ids.typedExpired, `${full}, '2020-01-01', 'Typed Expired'`);
    await db.query(
      `INSERT INTO idv_check_records
        (record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, result, staff_id,
         inspector_staff_id, verified_at, document_type, document_number_ciphertext, document_number_last4,
         number_unavailable, issuing_jurisdiction, issuing_country, expiry_date, name_on_id)
       VALUES ($1,'tnt-yorkfx','le-other-shop','br-yorkville',$2,'1','in_person','pass','m.costa',
         'm.costa', now(), 'Passport', 'aes-256-gcm$seam', '8888', false, 'Canada', 'CA', '2030-04-01', 'Other Shop')`,
      [`idc_other_${ids.otherShop}`, ids.otherShop],
    );
    await typedRow(ids.typedOld, `'m.costa', now() - interval '6 years', 'Passport', 'aes-256-gcm$seam', '2222', false, 'Canada', 'CA', '2030-04-01', 'Typed Old'`);
    await typedRow(ids.typedUnavailable, `'m.costa', now(), 'Passport', 'aes-256-gcm$seam', '7777', true, 'Canada', 'CA', '2030-04-01', 'Typed Unavailable'`);
    await page.locator('[data-app="clients"]').click();
    await page.waitForFunction((id) => {
      const clients = JSON.parse(localStorage.getItem("cdos_clients_v1") || "{}") as Record<string, { clientId?: string; idStanding?: { onFile?: boolean } }>;
      return Object.values(clients).some((rec) => rec && rec.clientId === id && rec.idStanding);
    }, ids.pass);

    const readFlags = (id: string) => page.evaluate((clientId) => {
      const clients = JSON.parse(localStorage.getItem("cdos_clients_v1") || "{}") as Record<string, { clientId?: string; idStanding?: { chip: string; onFile: boolean } }>;
      const name = Object.keys(clients).find((key) => clients[key] && clients[key].clientId === clientId) || "";
      const row = { id: "agree-row", customer: name, status: "posted", type: "Currency Exchange", inAmt: 10000, inCcy: "CAD", outAmt: 7000, outCcy: "USD", date: "2026-11-16", time: "12:00", fee: 0 };
      const flags = (window as unknown as { CDOS: { computeFlags: (rows: unknown[], clients: unknown, settings: unknown) => Record<string, { kyc: string }> } }).CDOS.computeFlags([row], clients, { threshold: 10000, idRequiredOver: 1, baselineRules: true });
      return { kyc: flags["agree-row"].kyc, chip: clients[name].idStanding?.chip, onFile: !!clients[name].idStanding?.onFile };
    }, id);

    const openName = async (name: string) => {
      await page.locator('[data-app="clients"]').click();
      await page.getByText(name, { exact: true }).click();
      await expect(page.getByTestId("client-standing")).toBeVisible();
    };
    const closeFile = async () => {
      await page.locator(".client-file-actions button").last().click();
    };

    await openName(names.pass);
    await expect(page.getByTestId("client-standing")).toContainText("ID on file");
    await expect(page.getByTestId("client-where")).toContainText("Identified");
    await closeFile();
    await openName(names.unavailable);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).toContainText("Not identified");
    await expect(page.getByTestId("client-where")).not.toContainText("ID checked");
    await closeFile();
    await openName(names.expired);
    await expect(page.getByTestId("client-standing")).toContainText("ID expired");
    await expect(page.getByTestId("client-where")).toContainText("ID expired");
    await expect(page.getByTestId("client-where")).not.toContainText("ID checked");
    await closeFile();
    await openName(names.old);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).not.toContainText("ID checked");
    await closeFile();
    await openName(names.typed);
    await expect(page.getByTestId("client-standing")).toContainText("ID on file");
    await expect(page.getByTestId("client-where")).toContainText("ID seen in person by m.costa, Passport, expires 1 Apr 2030, checked");
    await closeFile();
    await openName(names.noStaff);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).toContainText("ID typed in, check not recorded");
    await closeFile();
    await openName(names.noDate);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).toContainText("ID typed in, check not recorded");
    await closeFile();
    await openName(names.typedExpired);
    await expect(page.getByTestId("client-standing")).toContainText("ID expired");
    await expect(page.getByTestId("client-where")).toContainText("Expired 1 Jan 2020. A new ID check is needed before the next deal of $3,000 or more.");
    await closeFile();
    await openName(names.otherShop);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).not.toContainText("ID seen in person");
    await closeFile();
    await openName(names.typedOld);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).not.toContainText("ID seen in person");
    await closeFile();
    await openName(names.typedUnavailable);
    await expect(page.getByTestId("client-standing")).toContainText("Missing ID");
    await expect(page.getByTestId("client-where")).not.toContainText("ID seen in person");
    await closeFile();

    expect(await readFlags(ids.pass)).toMatchObject({ kyc: "ok", chip: "ID on file", onFile: true });
    expect(await readFlags(ids.unavailable)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.expired)).toMatchObject({ kyc: "ID expired", chip: "ID expired", onFile: false });
    expect(await readFlags(ids.old)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.typed)).toMatchObject({ kyc: "ok", chip: "ID on file", onFile: true });
    expect(await readFlags(ids.noStaff)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.noDate)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.typedExpired)).toMatchObject({ kyc: "ID expired", chip: "ID expired", onFile: false });
    expect(await readFlags(ids.otherShop)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.typedOld)).toMatchObject({ kyc: "missing ID", onFile: false });
    expect(await readFlags(ids.typedUnavailable)).toMatchObject({ kyc: "missing ID", onFile: false });

    await page.locator('[data-app="clients"]').click();
    await page.getByTestId("client-filter-attention").click();
    await expect(page.getByText(names.pass, { exact: true })).toHaveCount(0);
    await expect(page.getByText(names.unavailable, { exact: true })).toBeVisible();
    await expect(page.getByText(names.expired, { exact: true })).toBeVisible();
    await expect(page.getByText(names.old, { exact: true })).toBeVisible();
    await expect(page.getByText(names.typed, { exact: true })).toHaveCount(0);
    await expect(page.getByText(names.noStaff, { exact: true })).toBeVisible();
    await expect(page.getByText(names.noDate, { exact: true })).toBeVisible();
    await expect(page.getByText(names.typedExpired, { exact: true })).toBeVisible();
    await expect(page.getByText(names.otherShop, { exact: true })).toBeVisible();
    await expect(page.getByText(names.typedOld, { exact: true })).toBeVisible();
    await expect(page.getByText(names.typedUnavailable, { exact: true })).toBeVisible();

    await page.locator('[data-app="ledger"]').click();
    await ensureTill(page);
    tillClose = await readTillClose(page);
    let deal = page.getByRole("button", { name: /^New transaction$/i }).first();
    if (!(await deal.isEnabled())) {
      await page.reload();
      await landOnDesktop(page);
      await page.locator('[data-app="ledger"]').click();
      deal = page.getByRole("button", { name: /^New transaction$/i }).first();
    }
    await expect(deal).toBeEnabled({ timeout: 20_000 });
    await deal.click();
    await expect(page.locator(".cd-tx")).toBeVisible();
    await page.locator(".cd-tx-customer input").fill(names.pass);
    await page.locator(".cd-tx-suggest button.justify-between").filter({ hasText: names.pass }).click();
    await expect(page.getByTestId("deal-id-badge")).toContainText("ID on file");
    await page.locator(".cd-tx-customer input").fill(names.expired);
    await page.locator(".cd-tx-suggest button.justify-between").filter({ hasText: names.expired }).click();
    await expect(page.getByTestId("deal-id-badge")).toContainText("ID expired");
    await page.locator(".cd-tx-customer input").fill(names.typed);
    await page.locator(".cd-tx-suggest button.justify-between").filter({ hasText: names.typed }).click();
    await expect(page.getByTestId("deal-id-badge")).toContainText("ID on file");
    await page.locator(".cd-tx-customer input").fill(names.typedExpired);
    await page.locator(".cd-tx-suggest button.justify-between").filter({ hasText: names.typedExpired }).click();
    await expect(page.getByTestId("deal-id-badge")).toContainText("ID expired");
    await page.locator(".cd-tx-customer input").fill(names.noStaff);
    await page.locator(".cd-tx-suggest button.justify-between").filter({ hasText: names.noStaff }).click();
    await expect(page.getByTestId("deal-id-badge")).not.toContainText("ID on file");
    await page.locator(".cd-tx-x").click();
    const held = tillClose;
    tillClose = null;
    await signInAtDesk(page, "a.singh");
    expect(await closeHeldTill(page, held)).toBe("closed");
  } finally {
    if (tillClose && tillClose.status === "open") {
      await signInAtDesk(page, "a.singh").catch(() => {});
      await closeHeldTill(page, tillClose);
    }
    await db.end();
  }
});
