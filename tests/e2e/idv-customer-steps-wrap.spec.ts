/* The phone sheet forces flex text onto one line. The Didit steps
   are sentences, so at 390 they must wrap inside the card. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";

const root = process.cwd();
const require = createRequire(path.join(root, "package.json"));
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

const css = [
  readFileSync(path.join(root, "web/app/tw.css"), "utf8"),
  readFileSync(path.join(root, "os-src/york-os.css"), "utf8"),
].join("\n");
const react = readFileSync(path.join(root, "node_modules/react/umd/react.production.min.js"), "utf8");
const reactDom = readFileSync(path.join(root, "node_modules/react-dom/umd/react-dom.production.min.js"), "utf8");
const compiled = transform(readFileSync(path.join(root, "os-src/cdos-id-check.jsx"), "utf8"), {
  presets: ["react"],
  filename: "cdos-id-check.jsx",
  sourceType: "script",
}).code;
if (!compiled) throw new Error("id check did not compile");

test("Didit customer steps stay inside the card at 390", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html>
<html>
<head><meta charset="utf-8"><style>${css}html,body{margin:0}</style></head>
<body>
<script>${react}</script>
<script>${reactDom}</script>
<script>
window.CDOS = {
  CD: new Proxy({}, { get: function(_, key) {
    return typeof key === "string" ? "var(--cd-ink)" : "";
  } }),
  Backend: { IdCheck: {
    copy: function() { return Promise.resolve({
      provider: "didit", tier4: "unavailable", counterOnly: false, quebec: false,
      faceCrop: false, version: "shot", notice: "Before we check your ID",
      selfieConsent: "Optional face match"
    }); },
    checks: function() { return Promise.resolve({ records: [] }); }
  } }
};
</script>
<script>${compiled}</script>
<div id="mount"></div>
<script>
ReactDOM.createRoot(document.getElementById("mount")).render(
  React.createElement(window.CDOS.IdCheck.Flow, { clientId: "c-1", onClose: function() {} })
);
</script>
</body></html>`, { waitUntil: "load" });

  await page.getByTestId("id-check-customer-steps").waitFor();
  const rows = await page.locator(".id-check-step-text").evaluateAll((nodes) => nodes.map((el) => ({
    text: el.textContent || "",
    scroll: el.scrollWidth,
    client: el.clientWidth,
    whiteSpace: getComputedStyle(el).whiteSpace,
  })));
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(row.whiteSpace, row.text).toBe("normal");
    expect(row.client, row.text).toBeGreaterThan(0);
    expect(row.scroll, row.text).toBeLessThanOrEqual(row.client + 1);
  }
});

const LINK = "https://verify.didit.me/session/fixturetoken";
const SHOP = "York Currency Exchange Inc.";
const CONTACT = "privacy@yorkfx.ca";
const TEXT = `${SHOP} sent you this link to complete your ID check:\n${LINK}\n\nIf you did not ask for this, you can ignore it, or contact ${SHOP} at ${CONTACT}.`;

async function openLink(page: import("@playwright/test").Page, width: number, sendFails: boolean) {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.setContent(`<!doctype html>
<html>
<head><meta charset="utf-8"><style>${css}html,body{margin:0;background:#f4f0e6}</style></head>
<body>
<script>${react}</script>
<script>${reactDom}</script>
<script>
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: function(value) { window.__copied = value; return Promise.resolve(); } }
});
window.CDOS = {
  CD: new Proxy({}, { get: function(_, key) {
    return typeof key === "string" ? "var(--cd-ink)" : "";
  } }),
  Backend: {
    Clients: { get: function() { return Promise.resolve({ email: "a.client@staging.invalid" }); } },
    IdCheck: {
      copy: function() { return Promise.resolve({
        provider: "didit", tier4: "unavailable", counterOnly: false, quebec: false,
        faceCrop: false, version: "shot", notice: "Before we check your ID",
        selfieConsent: "Optional face match", shopName: ${JSON.stringify(SHOP)}
      }); },
      checks: function() { return Promise.resolve({ records: [] }); },
      start: function() { return Promise.resolve({ providerRef: "inq-1", connected: true }); },
      consent: function() { return Promise.resolve({ consentId: "cns-1" }); },
      link: function() { return Promise.resolve({ url: ${JSON.stringify(LINK)} }); },
      sendLink: function() { return ${sendFails ? "Promise.reject(Object.assign(new Error(\"The email didn't go. Try again, or use Copy link.\"), { status: 502 }))" : "Promise.resolve({ sent: true })"}; },
      noteLink: function(_id, body) {
        if (body && body.kind === "text") return Promise.resolve({ shop: ${JSON.stringify(SHOP)}, contact: ${JSON.stringify(CONTACT)}, text: ${JSON.stringify(TEXT)} });
        return Promise.resolve({ recorded: true });
      }
    }
  }
};
</script>
<script>${compiled}</script>
<div id="mount"></div>
<script>
ReactDOM.createRoot(document.getElementById("mount")).render(
  React.createElement(window.CDOS.IdCheck.Flow, { clientId: "c-1", onClose: function() {} })
);
</script>
</body></html>`, { waitUntil: "load" });
  await page.getByTestId("id-check-primary").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("id-check-agree-box").check();
  await page.getByRole("button", { name: "I agree" }).click();
  await page.getByTestId("id-check-send").waitFor();
}

for (const width of [390, 1280]) {
  test(`Didit link screen sends, copies, and stays inside ${width}`, async ({ page }) => {
    await openLink(page, width, false);
    await expect(page.getByTestId("id-check-send-email")).toHaveValue("a.client@staging.invalid");
    const box = await page.getByTestId("id-check-send").boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width + 1).toBe(true);
    await page.getByTestId("id-check-send-email-btn").click();
    await expect(page.getByTestId("id-check-send-email-btn").locator("[data-label]")).toHaveText("Email sent.");
    await page.getByTestId("id-check-copy-link").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(LINK);
    await expect(page.getByTestId("id-check-copy-link").locator("[data-label]")).toHaveText("Link copied.");
    await page.getByTestId("id-check-copy-text").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(TEXT);
    await expect(page.getByTestId("id-check-copy-text").locator("[data-label]")).toHaveText("Text copied.");
    await expect(page.getByTestId("id-check-link-how")).toHaveCount(0);
    await expect(page.getByText("Hand the counter device")).toHaveCount(0);
  });
}

function label(page: import("@playwright/test").Page, testId: string) {
  return page.getByTestId(testId).locator("[data-label]");
}

async function box(page: import("@playwright/test").Page, testId: string) {
  const found = await page.getByTestId(testId).boundingBox();
  if (!found) throw new Error(`${testId} has no box`);
  return found;
}

test("confirmations revert after 2000 ms, restart, and keep the button size", async ({ page }) => {
  const start = new Date("2026-11-25T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await openLink(page, 1280, false);
  expect(await page.evaluate(() => (window as unknown as { CDOS: { IdCheck: { buttonFeedbackMs: number } } }).CDOS.IdCheck.buttonFeedbackMs)).toBe(2000);

  const send = page.getByTestId("id-check-send-email-btn");
  const link = page.getByTestId("id-check-copy-link");
  const text = page.getByTestId("id-check-copy-text");
  const status = page.getByRole("status");
  const sendIdle = await box(page, "id-check-send-email-btn");
  const linkIdle = await box(page, "id-check-copy-link");
  const textIdle = await box(page, "id-check-copy-text");
  const sendColour = await send.evaluate((el) => getComputedStyle(el).backgroundColor);
  const linkColour = await link.evaluate((el) => getComputedStyle(el).backgroundColor);

  await send.click();
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Email sent.");
  await expect(send).toBeFocused();
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Email sent.");
  await expect(send.locator("svg")).toHaveCount(0);
  expect(await send.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(sendColour);
  const sendShown = await box(page, "id-check-send-email-btn");
  const linkAfterSend = await box(page, "id-check-copy-link");
  expect(Math.round(sendShown.width)).toBe(Math.round(sendIdle.width));
  expect(Math.round(sendShown.height)).toBe(Math.round(sendIdle.height));
  expect(Math.round(linkAfterSend.x)).toBe(Math.round(linkIdle.x));
  expect(Math.round(linkAfterSend.y)).toBe(Math.round(linkIdle.y));

  await page.clock.fastForward(1999);
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Email sent.");
  await page.clock.fastForward(1);
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Send");

  await send.click();
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Email sent.");
  await page.clock.fastForward(1500);
  await send.click();
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Email sent.");
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText("Email sent.");
  await page.clock.fastForward(1500);
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Email sent.");
  await page.clock.fastForward(500);
  await expect(label(page, "id-check-send-email-btn")).toHaveText("Send");

  await link.click();
  await expect(label(page, "id-check-copy-link")).toHaveText("Link copied.");
  await expect(link).toBeFocused();
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText("Link copied.");
  await expect(link.locator("svg")).toHaveCount(0);
  expect(await link.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(linkColour);
  const linkShown = await box(page, "id-check-copy-link");
  const textAfterLink = await box(page, "id-check-copy-text");
  expect(Math.round(linkShown.width)).toBe(Math.round(linkIdle.width));
  expect(Math.round(linkShown.height)).toBe(Math.round(linkIdle.height));
  expect(Math.round(textAfterLink.x)).toBe(Math.round(textIdle.x));
  expect(Math.round(textAfterLink.y)).toBe(Math.round(textIdle.y));
  await page.clock.fastForward(2000);
  await expect(label(page, "id-check-copy-link")).toHaveText("Copy link");

  await text.click();
  await expect(label(page, "id-check-copy-text")).toHaveText("Text copied.");
  await expect(text).toBeFocused();
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText("Text copied.");
  const textShown = await box(page, "id-check-copy-text");
  expect(Math.round(textShown.width)).toBe(Math.round(textIdle.width));
  expect(Math.round(textShown.height)).toBe(Math.round(textIdle.height));
  await page.clock.fastForward(1000);
  await text.click();
  await expect(label(page, "id-check-copy-text")).toHaveText("Text copied.");
  await expect(status).toHaveText("Text copied.");
  await page.clock.fastForward(1000);
  await expect(label(page, "id-check-copy-text")).toHaveText("Text copied.");
  await page.clock.fastForward(1000);
  await expect(label(page, "id-check-copy-text")).toHaveText("Copy text");
});

test("Didit link screen shows the email error", async ({ page }) => {
  await openLink(page, 390, true);
  await page.getByTestId("id-check-send-email-btn").click();
  await expect(page.getByTestId("id-check-send-error")).toContainText("The email didn't go. Try again, or use Copy link.");
  await expect(page.getByTestId("id-check-try-again")).toBeVisible();
});
