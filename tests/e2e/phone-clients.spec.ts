/* Phone Clients. At 360 and 390 the list is search, chips, and rows.
   The desktop Clients window is the shared 1280 picture in
   desktop-unchanged.spec.ts. Amounts carry a currency code. A stored
   "verified" word does not paint Verified — ID checks are not connected. */
import { mkdirSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop, hasLedger } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/screenshots";
const HEIGHT = 844;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await settled(page);
}

async function openClients(page: Page): Promise<void> {
  const phone = page.locator('#phonebar [data-phone-app="clients"]');
  if (await phone.isVisible()) await phone.click();
  else await page.locator('#appbar [data-app="clients"]').click();
  await dismissTour(page);
  await settled(page);
}

function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The sweep resizes. Pass one width so this test stays on that phone. */
function sweep(page: Page, width: number) {
  return phoneSweep(page, {
    roots: [".phone-clients", ".phone-head", "#phone-dock"],
    widths: [width],
  });
}

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/* Keep other specs' customers and deals off this screen. */
async function emptyBook(page: Page, clients: (route: Route) => Promise<void>): Promise<void> {
  await page.route("**/api/clients*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/clients") return clients(route);
    return route.continue();
  });
  await page.route("**/api/ledger/transactions*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.pathname === "/api/ledger/transactions") {
      return fulfill(route, 200, { transactions: [] });
    }
    return route.continue();
  });
}

test.describe("phone clients", () => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL");

  for (const width of [360, 390] as const) {
    test(`empty, loading, and a failed load at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let hold = true;
      await emptyBook(page, async (route) => {
        if (hold) await gate;
        return fulfill(route, 200, { clients: [] });
      });
      await atDesk(page);
      await openClients(page);
      await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "loading");
      await expect(page.getByRole("status", { name: "Loading clients" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
      await page.getByRole("button", { name: "Add client" }).click({ force: true });
      await expect(page.locator(".add-contact-sheet")).toHaveCount(0);
      await expect(page.locator(".phone-skel")).toHaveCount(4);
      await sweep(page, width);
      await shot(page, `clients_loading_${width}`);
      hold = false;
      release();
      await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "empty");
      await expect(page.getByRole("heading", { name: "No clients yet" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add client" })).toBeVisible();
      const emptyAccent = await page.locator(".phone-clients .phone-empty .phone-text-btn").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(emptyAccent).toBe("rgb(60, 59, 120)");
      await expect(page.locator(".phone-client-row")).toHaveCount(0);
      await sweep(page, width);
      await shot(page, `clients_empty_${width}`);

      /* A 5xx is said out loud. Names this browser is holding stay off the list. */
      await page.unroute("**/api/clients*");
      await page.route("**/api/clients*", async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === "GET" && url.pathname === "/api/clients") return fulfill(route, 500, { message: "down" });
        return route.continue();
      });
      await page.reload();
      await landOnDesktop(page);
      await dismissTour(page);
      await openClients(page);
      await expect(page.locator(".phone-clients .phone-state-card .phone-empty")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toBeVisible();
      await expect(page.getByText("Check the connection and try again.")).toBeVisible();
      await expect(page.locator(".phone-clients .phone-chip")).toHaveText(["All", "Missing ID", "Expired", "Identified"]);
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(page.locator(".phone-client-row")).toHaveCount(0);
      await expect(page.locator(".phone-clients")).not.toContainText("browser");
      await expect(page.locator(".phone-clients")).not.toContainText("Showing the copy");
      await expect(page.locator(".phone-clients")).not.toContainText("Verified");
      await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
      await sweep(page, width);
      await shot(page, `clients_error_${width}`);

      /* A copy this phone already held stays on the list, and says so.
         Add client still does not write another browser-only record. */
      await page.evaluate(() => {
        localStorage.setItem("cdos_clients_v1", JSON.stringify({
          "Mara Local": { kind: "individual", idType: "Passport", idNum: "LOCAL-1", idExpiry: "2035-01-01" },
        }));
      });
      await page.reload();
      await landOnDesktop(page);
      await dismissTour(page);
      await openClients(page);
      await expect(page.getByText("Showing the copy on this phone. It may be out of date.")).toBeVisible();
      await expect(page.locator(".phone-client-row")).toContainText("Mara Local");
      await expect(page.locator(".phone-client-row")).toHaveCount(1);
      await expect(page.locator(".phone-client-row.id-missing .phone-badge")).toHaveText("Missing ID");
      await expect(page.locator(".phone-client-row.id-identified")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
      await page.getByRole("button", { name: "Add client" }).click({ force: true });
      await expect(page.locator(".add-contact-sheet")).toHaveCount(0);
      await page.locator(".phone-client-row").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test(`search, chips, and ID standing at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      await atDesk(page);
      const tag = `Px${Date.now().toString(36)}${width}`;
      const names = {
        none: `${tag} NoDoc`,
        expired: `${tag} Expired`,
        passport: `${tag} Passport`,
      };
      const made = await page.evaluate(async (who) => {
        const post = async (path: string, body: unknown) => {
          const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => ({}));
          return { status: response.status, payload };
        };
        const out: Record<string, { status: number; id: string | null; doc: number | null }> = {};
        for (const [key, name] of Object.entries(who.names) as Array<[string, string]>) {
          const created = await post("/api/clients", {
            legalName: name,
            kind: "individual",
            verificationStatus: "verified",
          });
          const id = created.payload && typeof created.payload.clientId === "string" ? created.payload.clientId : null;
          let doc: number | null = null;
          if (id && key !== "none") {
            const filed = await post(`/api/clients/${id}/documents`, {
              docType: "Passport",
              docNumber: key === "expired" ? `EX-${who.tag}` : `PA-${who.tag}`,
              expiresOn: key === "expired" ? "2020-01-01" : "2035-01-01",
              isPrimary: true,
            });
            doc = filed.status;
          }
          out[key] = { status: created.status, id, doc };
        }
        return out;
      }, { names, tag });
      expect(made.none.status, JSON.stringify(made)).toBe(201);
      expect(made.expired.status).toBe(201);
      expect(made.passport.status).toBe(201);
      expect(made.expired.doc).toBe(201);
      expect(made.passport.doc).toBe(201);

      await openClients(page);
      const root = page.locator(".phone-clients");
      await expect(root).toBeVisible();
      await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "list");
      const inset = await page.evaluate(() => {
        const title = document.querySelector(".phone-clients .phone-title h1");
        const chip = document.querySelector(".phone-clients .phone-chip");
        const shell = document.querySelector(".phone-clients");
        const row = document.querySelector(".phone-client-row");
        const badge = row && row.querySelector(".phone-badge");
        const box = (el: Element | null) => el ? el.getBoundingClientRect() : null;
        const titleBox = box(title);
        const chipBox = box(chip);
        const rowBox = box(row);
        const sub = row && row.querySelector(".phone-row-sub");
        const badgeBox = box(badge);
        const subBox = box(sub);
        const titleLine = box(row && row.querySelector(".phone-row-title"));
        const scroll = document.querySelector(".phone-clients .phone-scroll");
        const header = document.querySelector(".phone-clients .phone-sec");
        const rowH = rowBox ? rowBox.height : 0;
        const view = scroll ? scroll.getBoundingClientRect().height : 0;
        const headerH = header ? header.getBoundingClientRect().height : 0;
        const bg = shell ? getComputedStyle(shell).backgroundColor : "";
        const image = shell ? getComputedStyle(shell).backgroundImage : "";
        return {
          title: titleBox ? Math.round(titleBox.left) : -1,
          chip: chipBox ? Math.round(chipBox.left) : -1,
          row: rowH,
          visible: rowH ? Math.floor((view - headerH) / rowH) : 0,
          badgeBeside: !!(badgeBox && subBox && badgeBox.left >= subBox.right - 2 && Math.abs(badgeBox.top - subBox.top) < 12),
          titleAbove: !!(titleLine && subBox && titleLine.bottom <= subBox.top + 4),
          line: sub ? (sub.textContent || "") : "",
          bg,
          image,
        };
      });
      expect(inset.title).toBeGreaterThanOrEqual(16);
      expect(inset.chip).toBeGreaterThanOrEqual(16);
      expect(inset.row).toBeGreaterThanOrEqual(64);
      expect(inset.row).toBeLessThanOrEqual(80);
      expect(inset.badgeBeside).toBe(true);
      expect(inset.titleAbove).toBe(true);
      if (width === 390) expect(inset.visible).toBeGreaterThanOrEqual(6);
      expect(inset.image).toBe("none");
      expect(inset.bg).toBe("rgb(255, 255, 255)");
      await root.getByLabel("Search clients").fill(tag);
      await expect(page.locator(".phone-client-row")).toHaveCount(3);
      const noneLine = page.locator(".phone-client-row", { hasText: names.none }).locator(".phone-row-sub");
      await expect(noneLine).toHaveText("No ID on file");
      await expect(page.locator(".phone-clients .phone-sec-meta")).toHaveText("Identified");
      const lines = await page.locator(".phone-client-row .phone-row-sub").allTextContents();
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).not.toContain("Individual");
      await expect(root).not.toContainText("$");
      await expect(root).not.toContainText("Verified");
      await expect(root.getByRole("button", { name: "New transaction" })).toHaveCount(0);
      await expect(page.locator("#phone-fab")).toHaveCount(0);
      await expect(page.locator("#phonebar button")).toHaveCount(5);
      await sweep(page, width);

      const money = await page.evaluate(() => {
        const format = (window as unknown as { CDOS: { formatPhoneMoney: (amount: unknown, currency: unknown) => string } }).CDOS.formatPhoneMoney;
        return {
          cad: format(1765.05, "CAD"),
          jpy: format(1765, "JPY"),
          bhd: format(1.5, "BHD"),
          missing: format(null, "CAD"),
          blank: format(10, ""),
        };
      });
      expect(money.cad).toBe("1,765.05 CAD");
      expect(money.jpy).toBe("1,765 JPY");
      expect(money.bhd).toBe("1.500 BHD");
      expect(money.missing).toBe("");
      expect(money.blank).toBe("");

      await shot(page, `clients_list_${width}`);

      await root.getByLabel("Search clients").fill(names.passport);
      await expect(page.locator(".phone-client-row")).toHaveCount(1);
      await expect(page.locator(".phone-client-row")).toContainText(names.passport);
      await expect(page.locator(".phone-client-row.id-identified .phone-badge")).toHaveText("Identified");
      await sweep(page, width);
      await shot(page, `clients_search_${width}`);

      await root.getByLabel("Search clients").fill(tag);
      await page.getByRole("tab", { name: /Missing ID/ }).click();
      await expect(page.locator(".phone-client-row")).toHaveCount(1);
      await expect(page.locator(".phone-client-row.id-missing .phone-badge")).toHaveText("Missing ID");
      await expect(page.locator(".phone-client-row")).toContainText(names.none);
      await expect(page.locator(".phone-client-row .phone-row-chev")).toHaveCount(1);
      await page.locator(".phone-client-row").click();
      const idDialog = page.getByRole("dialog", { name: "Record the ID for " + names.none });
      await expect(idDialog).toBeVisible();
      await expect(idDialog.locator("option", { hasText: "Health Card" })).toHaveCount(0);
      await expect(page.locator(".client-file")).toHaveCount(0);
      await page.getByRole("button", { name: "Back to client" }).last().click();
      await expect(idDialog).toHaveCount(0);
      await sweep(page, width);
      await shot(page, `clients_filtered_${width}`);

      await page.getByRole("tab", { name: /^Expired/ }).click();
      await expect(page.locator(".phone-client-row")).toHaveCount(1);
      await expect(page.locator(".phone-client-row.id-expired .phone-badge")).toHaveText("Expired");
      await expect(page.locator(".phone-client-row .phone-row-chev")).toHaveCount(1);
      await expect(page.locator(".phone-client-row")).toContainText(names.expired);

      await page.getByRole("tab", { name: /^Identified/ }).click();
      await expect(page.locator(".phone-client-row")).toHaveCount(1);
      await expect(page.locator(".phone-client-row .phone-badge")).toHaveText("Identified");
      await expect(page.locator(".phone-client-row .phone-row-chev")).toHaveCount(0);

      await page.locator(".phone-client-row").click();
      await expect(page.locator(".client-file")).toBeVisible();
      await expect(page.locator(".client-file")).toContainText(names.passport);
      await page.locator(".client-file-actions button").last().click();
      await expect(page.locator(".client-file")).toHaveCount(0);

      await root.getByRole("button", { name: "Add client" }).click();
      await expect(page.locator(".add-contact-sheet")).toBeVisible();
      await expect(page.getByText("Add a contact")).toBeVisible();
      await expect(page.getByText("Persona is not connected yet.")).toBeVisible();
      const skip = page.getByRole("button", { name: "Skip, add ID later" });
      await expect(skip).toBeVisible();
      const skipBox = await skip.boundingBox();
      expect(skipBox && skipBox.height).toBeGreaterThanOrEqual(44);
      const skipBg = await skip.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(skipBg === "rgba(0, 0, 0, 0)" || skipBg === "transparent").toBe(true);
    });
  }

  test("a load that is not the server list cannot add or record", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    let offline = false;
    await emptyBook(page, async (route) => {
      if (offline) return route.abort("internetdisconnected");
      return fulfill(route, 200, { clients: [] });
    });
    await atDesk(page);
    await openClients(page);
    await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "empty");

    offline = true;
    await page.context().setOffline(true);
    await page.evaluate(() => {
      const desk = window as unknown as { CDOS: { ClientRecords: { load: (force: boolean) => Promise<unknown> } } };
      return desk.CDOS.ClientRecords.load(true);
    });
    await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
    await page.getByRole("button", { name: "Add client" }).click({ force: true });
    await expect(page.locator(".add-contact-sheet")).toHaveCount(0);
    await expect(page.locator(".phone-client-row")).toHaveCount(0);
    await page.context().setOffline(false);

    await page.unroute("**/api/clients*");
    await page.route("**/api/clients*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.pathname === "/api/clients") {
        return fulfill(route, 401, { code: "AUTHENTICATION_REQUIRED", message: "Your session expired. Sign in again before posting." });
      }
      return route.continue();
    });
    await page.evaluate(() => {
      const desk = window as unknown as { CDOS: { ClientRecords: { load: (force: boolean) => Promise<unknown> } } };
      return desk.CDOS.ClientRecords.load(true);
    });
    await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
    await expect(page.locator(".phone-client-row")).toHaveCount(0);
  });

  test("ledger rows are not the client list", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    await page.route("**/api/clients*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.pathname === "/api/clients") return fulfill(route, 500, { message: "down" });
      return route.continue();
    });
    await page.route("**/api/ledger/customers*", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return fulfill(route, 200, { customers: [{ customerId: "cust_ledger_only", name: "Ledger Only" }] });
    });
    await page.route("**/api/ledger/transactions*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.pathname === "/api/ledger/transactions") {
        return fulfill(route, 200, {
          transactions: [{
            transactionId: "tx_ledger_only",
            transactionRef: "LX-1",
            postedAt: "2026-10-12T15:00:00.000Z",
            customerId: "cust_ledger_only",
            dealKind: "exchange",
            from: "CAD",
            to: "USD",
            inputAmount: "100.00",
            outputAmount: "70.00",
            rate: "1.4000",
            feeCad: "0.00",
          }],
        });
      }
      return route.continue();
    });
    await atDesk(page);
    await page.evaluate(() => localStorage.removeItem("cdos_clients_v1"));
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
    await openClients(page);
    await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toBeVisible();
    await expect(page.locator(".phone-client-row")).toHaveCount(0);
    await expect(page.locator(".phone-clients")).not.toContainText("Ledger Only");
  });

  test("a save writes the server first and shows its error", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    await emptyBook(page, async (route) => fulfill(route, 200, { clients: [] }));
    await atDesk(page);
    await openClients(page);
    await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "empty");
    await page.getByRole("button", { name: "Add client" }).click();
    await page.getByRole("button", { name: "Skip, add ID later" }).click();
    const name = "Mid Form " + Date.now().toString(36);
    await page.getByPlaceholder("Jane Doe").fill(name);
    await page.route("**/api/clients", async (route) => {
      if (route.request().method() === "POST") {
        return fulfill(route, 422, { code: "INVALID_REQUEST", message: "The server refused this client." });
      }
      return route.continue();
    });
    await page.getByText("Save without verifying").click();
    await expect(page.getByRole("alert")).toContainText("The server refused this client.");
    await expect(page.locator(".add-contact-sheet")).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem("cdos_clients_v1") || "");
    expect(stored).not.toContain(name);
  });

  test("ID standing, search, and the Toronto day", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    await atDesk(page);
    const tag = `Qy${Date.now().toString(36)}`;
    const healthNumber = `HC${tag}`;
    const names = {
      health: `${tag} Health`,
      blank: `${tag} NoNumber`,
      noExpiry: `${tag} NoExpiry`,
      today: `${tag} ExpiresToday`,
      nunez: `${tag} Núñez`,
    };
    const made = await page.evaluate(async (who) => {
      const branchDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        return { status: response.status, payload };
      };
      const file = async (name: string, doc: Record<string, unknown> | null, extra?: Record<string, unknown>) => {
        const created = await post("/api/clients", Object.assign({ legalName: name, kind: "individual" }, extra || {}));
        const id = created.payload && typeof created.payload.clientId === "string" ? created.payload.clientId : null;
        let docStatus: number | null = null;
        if (id && doc) docStatus = (await post(`/api/clients/${id}/documents`, doc)).status;
        return { status: created.status, docStatus };
      };
      return {
        branchDay,
        health: await file(who.names.health, { docType: "Health Card", docNumber: who.healthNumber, expiresOn: "2035-01-01", isPrimary: true }),
        blank: await file(who.names.blank, { docType: "Passport", docNumber: null, expiresOn: "2035-01-01", isPrimary: true }),
        noExpiry: await file(who.names.noExpiry, { docType: "Passport", docNumber: `NE-${who.tag}`, isPrimary: true }),
        today: await file(who.names.today, { docType: "Passport", docNumber: `TD-${who.tag}`, expiresOn: branchDay, isPrimary: true }),
        nunez: await file(who.names.nunez, null, { phone: "(416) 555-0199" }),
      };
    }, { names, tag, healthNumber });
    expect(made.health.status, JSON.stringify(made)).toBe(201);
    expect(made.health.docStatus).toBe(201);
    expect(made.blank.status).toBe(201);
    expect(made.blank.docStatus).toBe(201);
    expect(made.noExpiry.status).toBe(201);
    expect(made.noExpiry.docStatus).toBe(201);
    expect(made.today.status).toBe(201);
    expect(made.today.docStatus).toBe(201);
    expect(made.nunez.status).toBe(201);

    const rules = await page.evaluate((day) => {
      const CDOS = (window as unknown as {
        CDOS: {
          phoneIdStanding: (record: unknown, today: string) => { status: string; label: string; tone: string; reason: string };
          phoneDayWord: (date: string, at: string) => string;
          phoneBranchDay: (at: string) => string;
          displayIdStanding?: unknown;
        };
      }).CDOS;
      const previous = CDOS.displayIdStanding;
      CDOS.displayIdStanding = () => ({ status: "identified", label: "Identified", tone: "ok", reason: "" });
      const tone = CDOS.phoneIdStanding({ clientId: "cli_tone", serverBacked: true, idType: "Passport", idNum: "PA-1", idExpiry: day }, day);
      CDOS.displayIdStanding = previous;
      const at = "2026-10-13T01:00:00.000Z";
      return {
        tone: tone.tone,
        toneLabel: tone.label,
        branchAtNine: CDOS.phoneBranchDay(at),
        word: CDOS.phoneDayWord("2026-10-12", at),
        expiresToday: CDOS.phoneIdStanding({
          clientId: "cli_today", serverBacked: true, idType: "Passport", idNum: "PA-TODAY", idExpiry: "2026-10-12",
        }, CDOS.phoneBranchDay(at)),
        noNumber: CDOS.phoneIdStanding({
          clientId: "cli_blank", serverBacked: true, idType: "Passport", idNum: "", idExpiry: "2035-01-01",
        }, day),
        health: CDOS.phoneIdStanding({
          clientId: "cli_health", serverBacked: true, idType: "Health Card", idNum: "HC-1", idExpiry: "2035-01-01",
        }, day),
        localOnly: CDOS.phoneIdStanding({ idType: "Passport", idNum: "LOCAL", idExpiry: "2035-01-01" }, day),
      };
    }, made.branchDay);
    expect(rules.tone, "displayIdStanding ok paints green").toBe("pos");
    expect(rules.toneLabel).toBe("Identified");
    expect(rules.branchAtNine).toBe("2026-10-12");
    expect(rules.word).toBe("Today");
    expect(rules.expiresToday.status).toBe("identified");
    expect(rules.noNumber.status).toBe("missing");
    expect(rules.noNumber.reason).toBe("No ID number");
    expect(rules.health.status).toBe("missing");
    expect(rules.health.reason).toBe("Health cards can't be used as ID");
    expect(rules.localOnly.status).toBe("missing");

    await openClients(page);
    const root = page.locator(".phone-clients");
    const row = (name: string) => page.locator(".phone-client-row", { hasText: name });

    await root.getByLabel("Search clients").fill(names.health);
    await expect(row(names.health)).toHaveCount(1);
    await expect(row(names.health).locator(".phone-badge")).toHaveText("Missing ID");
    await expect(row(names.health)).toContainText("Health cards can't be used as ID");

    await root.getByLabel("Search clients").fill(healthNumber);
    await expect(page.locator(".phone-client-row")).toHaveCount(0);

    await root.getByLabel("Search clients").fill(names.blank);
    await expect(row(names.blank).locator(".phone-badge")).toHaveText("Missing ID");
    await expect(row(names.blank)).toContainText("No ID number");

    await root.getByLabel("Search clients").fill(names.noExpiry);
    await expect(row(names.noExpiry).locator(".phone-badge")).toHaveText("Missing ID");
    await expect(row(names.noExpiry)).toContainText("ID has no expiry date");

    await root.getByLabel("Search clients").fill(names.today);
    await expect(row(names.today).locator(".phone-badge")).toHaveText("Identified");
    await expect(row(names.today)).toHaveClass(/id-identified/);

    await root.getByLabel("Search clients").fill("nunez");
    await expect(row(names.nunez)).toHaveCount(1);
    await root.getByLabel("Search clients").fill("14165550199");
    await expect(row(names.nunez)).toHaveCount(1);
    await root.getByLabel("Search clients").fill("(416) 555-0199");
    await expect(row(names.nunez)).toHaveCount(1);
  });

  test("a slow client load says the server is waking", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: HEIGHT });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await emptyBook(page, async (route) => {
      await gate;
      return fulfill(route, 200, { clients: [] });
    });
    await atDesk(page);
    await page.clock.install();
    await openClients(page);
    await expect(page.getByRole("status", { name: "Loading clients" })).toBeVisible();
    await expect(page.getByText("Waking the server up, this can take a minute.")).toHaveCount(0);
    await page.clock.fastForward(20_000);
    await expect(page.getByText("Waking the server up, this can take a minute.")).toBeVisible();
    release();
    await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "empty", { timeout: 15_000 });
  });
});
