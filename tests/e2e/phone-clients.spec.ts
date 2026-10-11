/* Phone Clients. At 360 and 390 the list is search, chips, and rows.
   At 1280 the desktop Clients window is the one it already was.
   Amounts carry a currency code. A stored "verified" word does not
   paint Verified — ID checks are not connected. */
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
      await expect(page.locator(".phone-skel")).toHaveCount(4);
      await sweep(page, width);
      await shot(page, `clients_loading_${width}`);
      hold = false;
      release();
      await expect(page.locator("[data-phone-state]")).toHaveAttribute("data-phone-state", "empty");
      await expect(page.getByRole("heading", { name: "No clients yet" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Add client" })).toBeVisible();
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
        localStorage.setItem("cdos_clients_v1", JSON.stringify({ "Mara Local": { kind: "individual" } }));
      });
      await page.reload();
      await landOnDesktop(page);
      await dismissTour(page);
      await openClients(page);
      await expect(page.getByText("Showing the copy on this phone. It may be out of date.")).toBeVisible();
      await expect(page.locator(".phone-client-row")).toContainText("Mara Local");
      await expect(page.getByRole("heading", { name: "Couldn't load clients" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add client" })).toBeDisabled();
      await page.getByRole("button", { name: "Add client" }).click({ force: true });
      await expect(page.locator(".add-contact-sheet")).toHaveCount(0);
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
      expect(inset.line).toBe("No deals yet");
      expect(inset.line).not.toContain("Individual");
      if (width === 390) expect(inset.visible).toBeGreaterThanOrEqual(6);
      expect(inset.image).toBe("none");
      expect(inset.bg).toBe("rgb(255, 255, 255)");
      await root.getByLabel("Search clients").fill(tag);
      await expect(page.locator(".phone-client-row")).toHaveCount(3);
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
      await expect(page.getByRole("dialog", { name: "Record the ID" })).toBeVisible();
      await expect(page.locator(".client-file")).toHaveCount(0);
      await page.getByRole("button", { name: "Back to the deal" }).last().click();
      await expect(page.getByRole("dialog", { name: "Record the ID" })).toHaveCount(0);
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
    });
  }
});

test("desktop clients is the window it already was", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await emptyBook(page, (route) => fulfill(route, 200, { clients: [] }));
  await atDesk(page);
  await openClients(page);
  await expect(page.locator(".phone-clients")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New contact" })).toBeVisible();
  await expect(page.getByPlaceholder(/a file on their record/)).toBeVisible();
  await expect(page.getByRole("button", { name: /People/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Businesses/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Needs attention/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add client", exact: true })).toHaveCount(0);
  await expect(page.locator("#phonebar")).toBeHidden();
  const dest = process.env.DESKTOP_SHOT;
  if (dest) await page.locator(".win.show.active").screenshot({ path: dest });
});
