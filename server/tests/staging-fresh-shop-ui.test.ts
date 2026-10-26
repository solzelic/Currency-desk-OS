/* Start a fresh shop opens the existing desk setup.
   Live renders no button. Staging renders the button and no
   one-time card. Continuing is the real /onboarding/CD-... page. */
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

const api = require("../../os-src/staging-fresh-shop.js") as {
  freshShopButton: (enabled: unknown) => { label: string }[];
  freshShopMessage: (status: unknown) => string;
  freshShopEntry: (body: unknown) => string | null;
};
require("../../os-src/staging-signin.js");

const writes: string[] = [];
const localStorage = {
  getItem: () => null,
  setItem: (key: string, value: string) => { writes.push(String(key) + "=" + String(value)); },
  removeItem: () => {},
};
const documentStub = {
  documentElement: { getAttribute: () => "light", style: {} },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  body: { style: {}, appendChild() {}, removeChild() {} },
  getElementById: () => null,
  visibilityState: "visible",
};
const locationStub = { search: "", pathname: "/login", hash: "", hostname: "staging.currencydeskos.com", href: "http://staging.currencydeskos.com/login", assign(path: string) { this.href = path; } };

function loadJsx(file: string) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.React = React;
  g.localStorage = localStorage;
  g.document = documentStub;
  g.window = g;
  g.location = locationStub;
  const src = readFileSync(join(root, file), "utf8");
  const code = transform(src, { presets: ["react"], filename: file, sourceType: "script" }).code;
  if (!code) throw new Error(file);
  new Function("React", "window", "document", "localStorage", "location", code)(React, g, documentStub, localStorage, locationStub);
}

loadJsx("os-src/cdos-signin.jsx");

const desk = globalThis as unknown as {
  CDOS: { SignIn: unknown; CD: Record<string, string>; Ic: () => null };
};
desk.CDOS.CD = new Proxy({}, { get: () => "" });
desk.CDOS.Ic = () => null;

function draw(props: unknown) {
  return renderToStaticMarkup(React.createElement(desk.CDOS.SignIn as never, props));
}

const ROLES = ["Enter as Owner", "Enter as Manager", "Enter as Supervisor", "Enter as Compliance officer", "Enter as Teller", "Enter as Auditor"];

describe("fresh shop button", () => {
  it("stays off the live sign-in page and shows on staging", () => {
    for (const off of [false, undefined, null, 0, "1", { enabled: false }]) {
      expect(api.freshShopButton(off), JSON.stringify(off)).toEqual([]);
    }
    const live = draw({ employees: [] });
    expect(live).not.toContain("Start a fresh shop");
    expect(live).not.toContain("data-fresh-shop");
    const staging = draw({ employees: [], stagingOpen: true });
    expect(staging).toContain("Start a fresh shop");
    expect(staging).toContain('data-fresh-shop="1"');
    const fresh = staging.slice(staging.indexOf('data-fresh-shop="1"'), staging.indexOf('data-fresh-shop="1"') + 700);
    expect(fresh).toContain("Staging");
    expect(fresh).toContain("1px solid var(--si-mute)");
    expect(fresh).not.toContain("var(--si-primary)");
    for (const label of ROLES) expect(staging).toContain(label);
    expect(staging).not.toMatch(/\u2014|\u2013/);
    expect(staging).not.toContain("ONE-TIME PASSWORD");
    expect(staging).not.toContain("Shown once");
    expect(staging).not.toContain("data-fresh-card");
    const slow = draw({ employees: [], stagingOpen: true, freshProblem: 429 });
    expect(slow).toContain("Slow down. Try again in a little while.");
    const down = draw({ employees: [], stagingOpen: true, freshProblem: "network" });
    expect(down).toContain("The desk did not answer. Check your connection and try again.");
    expect(api.freshShopMessage(503)).toBe("Something went wrong. Try again.");
  });

  it("opens the existing onboarding page and not a one-time card", () => {
    expect(api.freshShopEntry({ ok: true, reference: "cd-ab23cd", email: "owner+ab12@staging.invalid" })).toBe("/onboarding/CD-AB23CD");
    expect(api.freshShopEntry({ reference: "CD-WALKTHRU" })).toBe("/onboarding/CD-WALKTHRU");
    expect(api.freshShopEntry({ email: "owner+ab12@staging.invalid", password: "temp-pass-word", code: "654321" })).toBeNull();
    expect(api.freshShopEntry(null)).toBeNull();
    const page = readFileSync(join(root, "os-src/cdos-signin.jsx"), "utf8");
    expect(page).toContain("freshShopEntry(data)");
    expect(page).toContain("freshShopButton(true)");
    expect(page).toContain("quick ?");
    expect(page).not.toContain("ONE-TIME PASSWORD");
    expect(page).not.toContain("leaveFreshCard");
    expect(page).not.toContain("data-fresh-card");
    const helper = readFileSync(join(root, "os-src/staging-fresh-shop.js"), "utf8");
    expect(helper).toContain('"/onboarding/"');
    expect(helper).not.toMatch(/localStorage|sessionStorage|location\.|console\./);
    expect(writes.join("\n")).toBe("");
    expect(locationStub.href).not.toContain("password");
    const os = readFileSync(join(root, "os-src/cdos-os.jsx"), "utf8");
    expect(os).not.toContain("shownCode");
    expect(os).not.toContain("afterFreshVerify");
  });
});
