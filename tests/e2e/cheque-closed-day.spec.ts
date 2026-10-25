/* A closed or signed-off day refuses a cheque return. The screen has to
   say so as a state, and it has to stop the three postings that the
   server will not take. Clearance stays available. */
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const REFUSAL = "This day is closed. Reversals and returns can't be posted to it.";
const RETURN_NEXT =
  "Open a new session on the till that paid this cheque out. Then post the return there.";
const REVERSAL_NEXT =
  "Open a new session on the till that paid this cheque out. A supervisor or manager then posts the reversal there.";

/* Same reading as the other desk specs. The closed-day title sits on
   the pink box and has to clear 4.5:1. */
function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastOf(fg: string, bg: string) {
  const read = (color: string) => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(color);
    const [r, g, b, a] = match[1].split(",").map((part) => Number(part.trim()));
    return { r, g, b, a: a == null ? 1 : a };
  };
  const back = read(bg);
  const front = read(fg);
  const over = front.a < 1
    ? {
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
      }
    : front;
  const lum = (rgb: { r: number; g: number; b: number }) =>
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  const light = Math.max(lum(over), lum(back));
  const dark = Math.min(lum(over), lum(back));
  return (light + 0.05) / (dark + 0.05);
}

type Rgb = { r: number; g: number; b: number };

function contrastChannels(fg: Rgb, bg: Rgb) {
  const lum = (rgb: Rgb) =>
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  const light = Math.max(lum(fg), lum(bg));
  const dark = Math.min(lum(fg), lum(bg));
  return (light + 0.05) / (dark + 0.05);
}

async function useTheme(page: Page, name: "light" | "dark") {
  await page.evaluate((theme) => {
    const cdos = (window as unknown as { CDOS?: { theme?: { set: (pref: string) => void } } }).CDOS;
    if (!cdos || !cdos.theme) throw new Error("theme controller missing");
    cdos.theme.set(theme);
  }, name);
  await expect(page.locator("html")).toHaveAttribute("data-cdtheme", name);
}

/* The night pink is a translucent wash, so the painted colour is that
   wash over the paper behind it. */
async function paintedContrast(title: Locator) {
  const sample = await title.evaluate((node) => {
    const parse = (color: string) => {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number(part.trim()));
      return {
        r: parts[0] || 0,
        g: parts[1] || 0,
        b: parts[2] || 0,
        a: parts[3] == null ? 1 : parts[3],
      };
    };
    const over = (
      front: { r: number; g: number; b: number; a: number },
      back: { r: number; g: number; b: number; a: number },
    ) => {
      const a = front.a + back.a * (1 - front.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
        a,
      };
    };
    const paint = (start: Element) => {
      const layers: { r: number; g: number; b: number; a: number }[] = [];
      let current: Element | null = start;
      while (current) {
        const bg = parse(getComputedStyle(current).backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        if (bg && bg.a >= 0.999) break;
        current = current.parentElement;
      }
      let acc = { r: 0, g: 0, b: 0, a: 0 };
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        if (layer) acc = over(layer, acc);
      }
      return { r: acc.r, g: acc.g, b: acc.b };
    };
    let box: Element | null = node;
    while (box) {
      const bg = parse(getComputedStyle(box).backgroundColor);
      if (bg && bg.a > 0.01) break;
      box = box.parentElement;
    }
    const fg = parse(getComputedStyle(node).color);
    if (!fg || !box) return null;
    return {
      fg: { r: fg.r, g: fg.g, b: fg.b },
      bg: paint(box),
      fgCss: getComputedStyle(node).color,
      bgCss: getComputedStyle(box).backgroundColor,
    };
  });
  if (!sample) throw new Error("could not read the title colour");
  return { ...sample, ratio: contrastChannels(sample.fg, sample.bg) };
}

async function cashHeldCheque(page: Page, maker: string) {
  await page.getByText(/^Cheques$/).first().click();
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
  const number = String(Date.now()).slice(-6);
  await page.getByPlaceholder("Type a name…").fill("Closed Day Customer");
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill("1200");
  await page.getByPlaceholder("e.g. 004821").fill(number);
  await page.getByPlaceholder("Payer name / business").fill(maker);
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill("Scotiabank");
  await page.getByRole("button", { name: /Cash & hold/i }).click();
  const returnNsf = page.getByRole("button", { name: "Return NSF" });
  await expect(returnNsf).toBeEnabled();
  return returnNsf;
}

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(async () => {
    const tour = (window as unknown as { CDOS_TOUR?: { record: Function } }).CDOS_TOUR;
    const ids = ["a.singh", "tnt-yorkfx:a.singh"];
    if (tour) ids.forEach((id) => tour.record(localStorage, id, "finished", "employee"));
    const persist = (window as unknown as { CDOS_PERSIST?: { save?: () => unknown } }).CDOS_PERSIST;
    if (persist && persist.save) await persist.save();
  });
  await expect(page.locator(".cdos-tour-skip")).toHaveCount(0);
}

async function ensureOpenSession(page: Page) {
  const status = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return opened.ok ? "open" : `${opened.status} ${await opened.text()}`;
  });
  await page.reload();
  await landOnDesktop(page);
  return status;
}

async function ensureDrawerHas(page: Page, wanted: number) {
  return page.evaluate(async (want) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const have = Number(held.balances?.CAD ?? 0);
    if (have >= want) return "ok";
    const answer = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `chq-closed-topup-${Date.now()}`,
        direction: "in",
        currency: "CAD",
        amount: (want - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "seam-fixture",
        reason: "Top-up so a closed-day cheque can be cashed",
      }),
    });
    return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
  }, wanted);
}

async function closeOpenSession(page: Page) {
  return page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const sessionId = current.session && current.session.sessionId;
    if (!sessionId) return "no session";
    const closed = await fetch(`/api/ledger/till-sessions/${sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `chq-closed-day-${Date.now()}`,
        counts: held.balances,
        note: "Signed off",
        balanceGeneration: held.balanceGeneration,
      }),
    });
    return closed.ok ? "ok" : `${closed.status} ${await closed.text()}`;
  });
}

async function openClosedCheque(page: Page) {
  await signInAtDesk(page);
  await dismissTour(page);

  const session = await ensureOpenSession(page);
  expect(session, `the till would not open: ${session}`).toBe("open");
  await dismissTour(page);
  const topUp = await ensureDrawerHas(page, 6000);
  expect(topUp, `the drawer could not be topped up: ${topUp}`).toBe("ok");

  await page.getByText(/^Cheques$/).first().click();
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();

  const number = String(Date.now()).slice(-6);
  await page.getByPlaceholder("Type a name…").fill("Closed Day Customer");
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill("1200");
  await page.getByPlaceholder("e.g. 004821").fill(number);
  await page.getByPlaceholder("Payer name / business").fill("Maple Payroll Services");
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill("Scotiabank");
  await page.getByRole("button", { name: /Cash & hold/i }).click();

  const returnNsf = page.getByRole("button", { name: "Return NSF" });
  const flagFraud = page.getByRole("button", { name: "Flag fraud" });
  const reverse = page.getByRole("button", { name: "Reverse cashing" });
  await expect(returnNsf).toBeVisible();
  await expect(returnNsf).toBeEnabled();

  const closed = await closeOpenSession(page);
  expect(closed, `the day would not close: ${closed}`).toBe("ok");
  return { returnNsf, flagFraud, reverse };
}

test("a closed day disables return, fraud and reversal and shows the next step", async ({ page }) => {
  const { returnNsf, flagFraud, reverse } = await openClosedCheque(page);

  await returnNsf.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(REFUSAL);
  await expect(alert).toContainText(RETURN_NEXT);
  await expect(alert).not.toContainText("supervisor or manager");
  await expect(returnNsf).toBeDisabled();
  await expect(flagFraud).toBeDisabled();
  await expect(reverse).toBeDisabled();
  await expect(page.getByRole("button", { name: /Mark cleared/ })).toBeEnabled();

  for (const button of [returnNsf, flagFraud, reverse]) {
    const box = await button.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(44);
  }

  const ink = await alert.evaluate((node) => {
    const title = node.querySelector(".font-semibold");
    return {
      fg: title ? getComputedStyle(title).color : "",
      bg: getComputedStyle(node).backgroundColor,
    };
  });
  const ratio = contrastOf(ink.fg, ink.bg);
  expect(ratio, `${ink.fg} on ${ink.bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
});

test("a closed-day reversal names a supervisor or manager", async ({ page }) => {
  const { reverse } = await openClosedCheque(page);
  page.once("dialog", (dialog) => dialog.accept("Wrong day"));
  await reverse.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(REFUSAL);
  await expect(alert).toContainText(REVERSAL_NEXT);
  await expect(alert).not.toContainText("Then post the return there.");
});

test("dark theme cheque titles and the returned subtitle clear 4.5:1", async ({ page }) => {
  const { returnNsf } = await openClosedCheque(page);
  await useTheme(page, "dark");
  await returnNsf.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(REFUSAL);
  const closed = await paintedContrast(alert.locator(".font-semibold"));

  if (process.env.CHEQUE_CLOSED_SHOTS === "1") {
    for (const width of [360, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await alert.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `docs/pr-shots/cheque-closed-day/alert-dark-${width}.png` });
    }
    await useTheme(page, "light");
    await page.setViewportSize({ width: 1280, height: 900 });
    await alert.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "docs/pr-shots/cheque-closed-day/alert-1280.png" });
    await useTheme(page, "dark");
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  const session = await ensureOpenSession(page);
  expect(session, `the next day would not open: ${session}`).toBe("open");
  await dismissTour(page);
  const topUp = await ensureDrawerHas(page, 6000);
  expect(topUp, `the drawer could not be topped up: ${topUp}`).toBe("ok");
  const postReturn = await cashHeldCheque(page, "Night Return Payroll");
  await postReturn.click();
  await expect(page.getByRole("button", { name: "Return NSF" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Returned/ }).click();
  await page.getByRole("button", { name: /Night Return Payroll/ }).click();
  const returnedTitle = page.locator("div.font-semibold", { hasText: "Returned" }).last();
  await expect(returnedTitle).toBeVisible();
  const returned = await paintedContrast(returnedTitle);
  const subtitle = returnedTitle.locator("xpath=following-sibling::*[1]");
  await expect(subtitle).toContainText("NSF");
  const sub = await paintedContrast(subtitle);

  const report = [
    `closed title ${closed.ratio.toFixed(2)}:1 (${closed.fgCss} on ${closed.bgCss})`,
    `returned title ${returned.ratio.toFixed(2)}:1 (${returned.fgCss} on ${returned.bgCss})`,
    `returned subtitle ${sub.ratio.toFixed(2)}:1 (${sub.fgCss} on ${sub.bgCss})`,
  ].join("; ");
  expect(closed.ratio, report).toBeGreaterThanOrEqual(4.5);
  expect(returned.ratio, report).toBeGreaterThanOrEqual(4.5);
  expect(sub.ratio, report).toBeGreaterThanOrEqual(4.5);
});
