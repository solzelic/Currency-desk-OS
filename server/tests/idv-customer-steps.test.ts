/* The Didit teller screen lists what the customer will see.
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
  "You share a link or a QR code.",
  "The customer scans their ID.",
  "The customer takes a selfie.",
  "The result comes back to you.",
  "There is no charge if the check fails.",
];
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
  return renderToStaticMarkup(node as never);
}

describe("Didit customer steps", () => {
  it("renders the five steps on a Didit shop", () => {
    const markup = html(customerSteps({ provider: "didit" }, false));
    expect(markup).toContain('data-testid="id-check-customer-steps"');
    expect(markup).toContain("What the customer sees");
    let at = 0;
    for (const line of STEPS) {
      expect(line).not.toMatch(DASH);
      expect(line).not.toMatch(FLAG);
      expect(line).not.toMatch(/\$|dollar|pound|euro|flag/i);
      const next = markup.indexOf(line);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(markup).toContain("max-width:100%");
    expect(markup).toContain("overflow-wrap:anywhere");
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
    expect(link).toContain("customerSteps(copy, counter)");
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
