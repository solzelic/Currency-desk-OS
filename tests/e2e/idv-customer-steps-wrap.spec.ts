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
const TEXT = `Check your ID at this link:\n${LINK}\n\nIf you did not ask for this, you can ignore it.`;

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
        selfieConsent: "Optional face match"
      }); },
      checks: function() { return Promise.resolve({ records: [] }); },
      start: function() { return Promise.resolve({ providerRef: "inq-1", connected: true }); },
      consent: function() { return Promise.resolve({ consentId: "cns-1" }); },
      link: function() { return Promise.resolve({ url: ${JSON.stringify(LINK)} }); },
      sendLink: function() { return ${sendFails ? "Promise.reject(Object.assign(new Error('The message was not sent. Try again.'), { status: 503 }))" : "Promise.resolve({ sent: true })"}; }
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
    await expect(page.getByTestId("id-check-send-sent")).toHaveText("The email was sent.");
    await page.getByTestId("id-check-copy-link").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(LINK);
    await expect(page.getByTestId("id-check-send-sent")).toHaveText("The link was copied.");
    await page.getByTestId("id-check-copy-text").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(TEXT);
    await expect(page.getByTestId("id-check-send-sent")).toHaveText("The text was copied.");
    await expect(page.getByTestId("id-check-link-how")).toHaveText("The link goes to the customer's email, or they get a copied message or the Copy link.");
    await expect(page.getByText("Hand the counter device")).toHaveCount(0);
  });
}

test("Didit link screen shows the email error", async ({ page }) => {
  await openLink(page, 390, true);
  await page.getByTestId("id-check-send-email-btn").click();
  await expect(page.getByTestId("id-check-send-error")).toHaveText("The message was not sent. Try again.");
});
