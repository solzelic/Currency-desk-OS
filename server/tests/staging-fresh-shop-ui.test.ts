/* The fresh-shop button is on the staging sign-in page only.
   Live renders nothing. The card shows the staff id and the one-time
   password once. Continuing reaches the real signup code screen,
   which shows the code, and drops the password. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const React = require("react") as { createElement: (...args: unknown[]) => unknown; useState: unknown };
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

const api = require("../../os-src/staging-fresh-shop.js") as {
  freshShopButton: (enabled: unknown) => { label: string }[];
  freshShopMessage: (status: unknown) => string;
  freshShopNotice: string;
  acceptFreshShop: (body: unknown) => { staffId: string; password: string; code: string } | null;
  leaveFreshCard: (held: { staffId: string; password: string; code: string } | null) => { email: string; code: string } | null;
  freshShopCode: (code: unknown) => { code: string; line: string } | null;
  afterFreshVerify: (user: { mustChangePassword?: boolean } | null) => string;
};
require("../../os-src/staging-signin.js");

const STAFF = "owner+ab12@staging.invalid";
const PASSWORD = "temp-pass-word";
const CODE = "654321";

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
const locationStub = { search: "", pathname: "/login", hash: "", hostname: "staging.currencydeskos.com", href: "http://staging.currencydeskos.com/login" };

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
  CDOS: {
    SignIn: unknown;
    VerifySignup?: unknown;
    freshShopButton: typeof api.freshShopButton;
    freshShopMessage: typeof api.freshShopMessage;
    freshShopNotice: string;
    acceptFreshShop: typeof api.acceptFreshShop;
    leaveFreshCard: typeof api.leaveFreshCard;
    freshShopCode: typeof api.freshShopCode;
    afterFreshVerify: typeof api.afterFreshVerify;
    CD: Record<string, string>;
    Ic: () => null;
  };
};
desk.CDOS.CD = new Proxy({}, { get: () => "" });
desk.CDOS.Ic = () => null;
loadJsx("os-src/cdos-os.jsx");

function draw(fn: unknown, props: unknown) {
  return renderToStaticMarkup(React.createElement(fn as never, props));
}

describe("fresh shop button", () => {
  it("stays off the live sign-in page and shows on staging", () => {
    for (const off of [false, undefined, null, 0, "1", { enabled: false }]) {
      expect(api.freshShopButton(off), JSON.stringify(off)).toEqual([]);
    }
    const live = draw(desk.CDOS.SignIn, { employees: [] });
    expect(live).not.toContain("Start a fresh shop");
    expect(live).not.toContain("data-fresh-shop");
    const staging = draw(desk.CDOS.SignIn, { employees: [], stagingOpen: true });
    expect(staging).toContain("Start a fresh shop");
    expect(staging).toContain('data-fresh-shop="1"');
    for (const label of ["Enter as Owner", "Enter as Manager", "Enter as Supervisor", "Enter as Compliance officer", "Enter as Teller", "Enter as Auditor"]) {
      expect(staging).toContain(label);
    }
    expect(staging).not.toMatch(/\u2014|\u2013/);
    const slow = draw(desk.CDOS.SignIn, { employees: [], stagingOpen: true, freshProblem: 429 });
    expect(slow).toContain("Slow down. Try again in a little while.");
    expect(slow).toContain("Start a fresh shop");
    const down = draw(desk.CDOS.SignIn, { employees: [], stagingOpen: true, freshProblem: "network" });
    expect(down).toContain("The desk did not answer. Check your connection and try again.");
  });

  it("renders the one-time card once and then the real code screen", () => {
    const held = api.acceptFreshShop({ ok: true, email: STAFF, slug: "stg-ab12cd34", code: CODE, password: PASSWORD });
    expect(held).not.toBeNull();
    if (!held) return;
    const card = draw(desk.CDOS.SignIn, { employees: [], freshStart: held });
    expect(card).toContain(STAFF);
    expect(card).toContain(PASSWORD);
    expect(card).toContain(api.freshShopNotice);
    expect(card).toContain("Copy");
    expect(card).not.toContain(CODE);
    const next = api.leaveFreshCard(held);
    expect(next).toEqual({ email: STAFF, code: CODE });
    expect(JSON.stringify(next)).not.toContain(PASSWORD);
    expect(Object.keys(next || {})).not.toContain("password");
    const gone = draw(desk.CDOS.SignIn, { employees: [], stagingOpen: true });
    expect(gone).not.toContain(PASSWORD);
    expect(gone).not.toContain(CODE);
    const Verify = desk.CDOS.VerifySignup;
    expect(Verify).toBeTypeOf("function");
    const codeScreen = draw(Verify, { email: next && next.email, shownCode: next && next.code, onVerified() {}, onBack() {} });
    expect(codeScreen).toContain("Enter your code");
    expect(codeScreen).toContain(CODE);
    expect(codeScreen).toContain("Type this code. It is shown here.");
    expect(codeScreen).not.toContain(PASSWORD);
    const emailed = draw(Verify, { email: "dana@maplefx.ca", onVerified() {}, onBack() {} });
    expect(emailed).toContain("We emailed a 6-digit code");
    expect(emailed).not.toContain(CODE);
    expect(emailed).not.toContain("Type this code. It is shown here.");
    expect(api.afterFreshVerify({ mustChangePassword: true })).toBe("signin");
    expect(api.afterFreshVerify({ mustChangePassword: false })).toBe("desk");
    expect(api.afterFreshVerify(null)).toBe("desk");
    expect(writes.join("\n")).not.toContain(PASSWORD);
    expect(writes.join("\n")).not.toContain(CODE);
    expect(locationStub.href).not.toContain(PASSWORD);
    expect(locationStub.href).not.toContain(CODE);
    const page = readFileSync(join(root, "os-src/cdos-signin.jsx"), "utf8");
    const os = readFileSync(join(root, "os-src/cdos-os.jsx"), "utf8");
    expect(page).toContain("leaveFreshCard");
    expect(page).toContain("freshShopButton(true)");
    expect(page).toContain("quick ?");
    expect(os).toContain("shownCode={signup && signup.code}");
    expect(os).toContain("afterFreshVerify");
    expect(os).toContain("setStage('verify')");
    const helper = readFileSync(join(root, "os-src/staging-fresh-shop.js"), "utf8");
    expect(helper).not.toMatch(/localStorage|sessionStorage|location\.|console\./);
    expect(api.freshShopMessage(503)).toBe("Something went wrong. Try again.");
    expect(api.freshShopCode("12")).toBeNull();
    expect(api.acceptFreshShop({ email: STAFF })).toBeNull();
  });
});
