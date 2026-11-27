/* The Didit teller screen lists what the customer does.
   Persona and a counter only shop render none of it. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const React = require("react") as { createElement: (...args: unknown[]) => unknown };
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

const STEPS = [
  "The link goes to the customer by email, or you copy a text. The counter device is never handed over.",
  "The customer reads the notice and chooses whether to go ahead. If they say no, check the ID at the counter.",
  "The customer scans their ID and takes a selfie with Didit.",
  "The result comes back to this screen.",
];
const BILLING = "Your shop is not billed for a check that is declined, abandoned or expired.";
const DASH = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D-]/;
const FLAG = /\u{1F1E6}|\u{1F1FF}|🇺🇸|🇨🇦|🇬🇧/u;

type StepsFn = (copy: { provider?: string } | null, counter: boolean) => unknown;

function loadSteps(): StepsFn {
  const g = globalThis as unknown as {
    React: unknown;
    ReactDOM: { createPortal: (node: unknown) => unknown };
    window: unknown;
    document: unknown;
    localStorage: { getItem: () => null; setItem: () => void; removeItem: () => void };
    CDOS: { CD: object; IdCheck?: { customerSteps: StepsFn } };
  };
  const CD = new Proxy({}, {
    get(_target, key) {
      if (typeof key !== "string") return "";
      return "var(--cd-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + ")";
    },
  });
  g.React = React;
  g.ReactDOM = { createPortal: (node) => node };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.document = {
    body: {
      dataset: {},
      setAttribute() {},
      removeAttribute() {},
      style: {},
    },
    addEventListener() {},
    removeEventListener() {},
  };
  g.CDOS = { CD };
  g.window = g;
  const src = readFileSync(join(root, "os-src/cdos-id-check.jsx"), "utf8");
  const code = transform(src, { presets: ["react"], filename: "cdos-id-check.jsx", sourceType: "script" }).code;
  if (!code) throw new Error("id check did not compile");
  new Function("React", "ReactDOM", "window", "document", "localStorage", code)(
    React, g.ReactDOM, g, g.document, g.localStorage,
  );
  const fn = g.CDOS.IdCheck && g.CDOS.IdCheck.customerSteps;
  if (!fn) throw new Error("customer steps are not on the ID check");
  return fn;
}

const customerSteps = loadSteps();

function html(node: unknown): string {
  return renderToStaticMarkup(node as never).replace(/&#x27;/g, "'");
}

describe("Didit customer steps", () => {
  it("renders what the customer does on a Didit shop", () => {
    const markup = html(customerSteps({ provider: "didit" }, false));
    expect(markup).toContain('data-testid="id-check-customer-steps"');
    expect(markup).toContain("What the customer does");
    expect(markup).not.toContain("What the customer sees");
    const list = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
    let at = 0;
    for (const line of STEPS) {
      expect(line).not.toMatch(DASH);
      expect(line).not.toMatch(FLAG);
      expect(line).not.toMatch(/\$|dollar|pound|euro|flag/i);
      const next = list.indexOf(line);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(list).not.toContain(BILLING);
    expect(BILLING).not.toMatch(DASH);
    const note = markup.indexOf('data-testid="id-check-customer-billing"');
    expect(note).toBeGreaterThan(markup.indexOf("</ol>"));
    expect(markup.indexOf(BILLING)).toBeGreaterThan(note);
    expect(markup).toContain("max-width:100%");
    expect(markup).toContain("id-check-step-text");
    const phone = readFileSync(join(root, "os-src/york-os.css"), "utf8");
    const rule = phone.slice(phone.indexOf("span.id-check-step-text"), phone.indexOf("span.id-check-step-text") + 240);
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("flex: 1 1 auto");
    expect(rule).toContain("min-width: 0");
    expect(markup).not.toMatch(FLAG);
    expect(markup).not.toContain("Persona");
    expect(markup).not.toContain("Verified");
    expect(markup).not.toContain("Approved");
  });

  it("stays off Persona and off a counter only shop", () => {
    expect(customerSteps({ provider: "persona" }, false)).toBeNull();
    expect(customerSteps({ provider: "didit" }, true)).toBeNull();
    expect(customerSteps({}, false)).toBeNull();
    expect(customerSteps(null, false)).toBeNull();
    const source = readFileSync(join(root, "os-src/cdos-id-check.jsx"), "utf8");
    const chooser = source.slice(source.indexOf('step === "chooser"'), source.indexOf('step === "opening"'));
    const link = source.slice(source.indexOf('step === "link"'), source.indexOf('step === "failed"'));
    expect(chooser).toContain("customerSteps(copy, counter)");
    expect(link).toContain("customerSteps(copy, counter,");
    expect(link).not.toContain("or they get a copied message or the Copy link.");
    expect(link).toContain("That email is not valid.");
    expect(link).toContain("id-check-try-again");
    expect(link).toContain("closed: narrow && !stepsOpen");
    expect(link).toContain("shopFromLine(copy.shopName)");
    expect(source).toContain("Waiting for the customer");
    expect(source).toContain("sent you this link to complete your ID check:");
    expect(source).toContain("If you did not ask for this, you can ignore it, or contact ");
    const line = (globalThis as unknown as { CDOS: { IdCheck: { shopFromLine: (shop: string) => string } } }).CDOS.IdCheck.shopFromLine;
    expect(line("York Currency Exchange Inc.")).toBe("This email comes from York Currency Exchange Inc.");
    expect(line("York FX")).toBe("This email comes from York FX.");
    expect(source).not.toContain("Hand the counter device");
    expect(source).not.toContain("ID, selfie and database is not available yet");
    expect(source).toContain("ID, selfie and database checks are not available yet.");
    const moreAt = chooser.indexOf('data-testid="id-check-more"');
    const tierAt = chooser.indexOf('data-testid="id-check-tier4"');
    expect(moreAt).toBeGreaterThan(chooser.indexOf("customerSteps(copy, counter)"));
    expect(tierAt).toBeGreaterThan(moreAt);
    expect(chooser.slice(0, moreAt)).not.toContain("id-check-tier4");
    expect(source).toContain('else if (next === "4") return;');
    const moreList = chooser.slice(chooser.indexOf('data-testid="id-check-more-list"'), tierAt);
    expect(moreList).toContain('height: "auto"');
    expect(moreList).toContain('overflow: "visible"');
    expect(moreList).toContain("px-4 py-2.5");
    const tierCard = chooser.slice(tierAt, chooser.indexOf("</div>}", tierAt));
    expect(tierCard).toContain('aria-disabled="true"');
    expect(tierCard).toContain("px-4 py-2.5");
    expect(tierCard).toContain('height: "auto"');
    expect(tierCard).toContain('overflow: "visible"');
    expect(tierCard).toContain("CD.mute");
    expect(source).not.toContain("\u2014");
    expect(source).not.toContain("\u2013");
    for (const file of [
      "design/onboarding/currencydesk-onboarding.html",
      "design/site/CurrencyDesk Early Access v2.dc.html",
      "os-src/cdos-kyc.jsx",
    ]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toContain("There is no charge if the check fails.");
    }
  });
});
