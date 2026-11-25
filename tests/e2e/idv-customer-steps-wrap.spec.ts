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
