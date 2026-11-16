/* Start a fresh shop opens the existing desk setup, and Start on Day 1
   opens a new test shop on its first day. Live renders neither button.
   Staging renders both and no one-time card. Continuing is the real
   /onboarding page. */
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

type Win = { sessionStorage: { setItem(k: string, v: string): void }; location: { assign(path: string): void } };
const api = require("../../os-src/staging-fresh-shop.js") as {
  freshShopButton: (enabled: unknown) => { key: string; mark: string; label: string; dayOne?: boolean }[];
  startDayOne: (win: Win) => void;
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
    expect(api.freshShopButton(true)).toEqual([
      { key: "fresh-shop", mark: "1", label: "Start a fresh shop" },
      { key: "day-one", mark: "day1", label: "Start on Day 1", dayOne: true },
    ]);
    const live = draw({ employees: [] });
    expect(live).not.toContain("Start a fresh shop");
    expect(live).not.toContain("Start on Day 1");
    expect(live).not.toContain("data-fresh-shop");
    const staging = draw({ employees: [], stagingOpen: true });
    expect(staging).toContain("Start a fresh shop");
    expect(staging).toContain('data-fresh-shop="1"');
    const fresh = staging.slice(staging.indexOf('data-fresh-shop="1"'), staging.indexOf('data-fresh-shop="1"') + 700);
    expect(fresh).toContain("Staging");
    expect(fresh).toContain("1px solid var(--si-mute)");
    expect(fresh).not.toContain("var(--si-primary)");
    /* Start on Day 1 sits beside it, in the same outline style, with the same tag */
    expect(staging).toContain('data-fresh-shop="day1"');
    const day = staging.slice(staging.indexOf('data-fresh-shop="day1"'), staging.indexOf('data-fresh-shop="day1"') + 700);
    expect(day).toContain("Start on Day 1");
    expect(day).toContain("Staging");
    expect(day).toContain("1px solid var(--si-mute)");
    expect(day).not.toContain("var(--si-primary)");
    expect(staging.indexOf('data-fresh-shop="1"')).toBeLessThan(staging.indexOf('data-fresh-shop="day1"'));
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

  it("opens the website with the staging ticket, and not a one-time card", () => {
    const start = "/?door=" + "ab".repeat(16) + "&email=owner%2Bab12%40staging.invalid";
    expect(api.freshShopEntry({ ok: true, start, email: "owner+ab12@staging.invalid" })).toBe(start);
    expect(api.freshShopEntry({ start: "https://evil.example/?door=" + "ab".repeat(16) + "&email=x" })).toBeNull();
    expect(api.freshShopEntry({ start: "//evil.example/?door=" + "ab".repeat(16) + "&email=x" })).toBeNull();
    expect(api.freshShopEntry({ start: "/?door=nothex&email=x" })).toBeNull();
    expect(api.freshShopEntry({ reference: "CD-WALKTHRU" })).toBeNull();
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
    expect(helper).toContain("\\/\\?door=");
    /* the website carries the ticket into the application */
    for (const site of ["web/index.html", "web/mobile.html"]) {
      const html = readFileSync(join(root, site), "utf8");
      expect(html, site).toContain("location.assign('/early-access' + carried)");
    }
    /* and the application pages do not carry the site's copy of it */
    expect(readFileSync(join(root, "web/early-access.html"), "utf8")).not.toContain("location.assign('/early-access' + carried)");
    /* and the page it opens reads the ticket and applies with it */
    const early = readFileSync(join(root, "web/early-access-v2.html"), "utf8");
    expect(early).toContain("q.get('door')");
    expect(early).toContain("stagingDoor: this._door");
    /* the helper keeps nothing: no localStorage, no console, and its one
       sessionStorage write is Start on Day 1's bare timestamp (below) */
    expect(helper).not.toMatch(/localStorage|console\./);
    expect(helper.match(/sessionStorage\.setItem\(/g)).toHaveLength(1);
    expect(page).toContain("window.CDOS.startDayOne(window)");
    expect(writes.join("\n")).toBe("");
    expect(locationStub.href).not.toContain("password");
    const os = readFileSync(join(root, "os-src/cdos-os.jsx"), "utf8");
    expect(os).not.toContain("shownCode");
    expect(os).not.toContain("afterFreshVerify");
  });
});

describe("Start on Day 1", () => {
  it("marks this tab with a bare timestamp, then opens the sign-up page at #day1", () => {
    const stored: [string, string][] = [];
    const opened: string[] = [];
    const before = Date.now();
    api.startDayOne({ sessionStorage: { setItem: (k, v) => { stored.push([k, v]); } }, location: { assign: (p) => { opened.push(p); } } });
    expect(opened).toEqual(["/onboarding#day1"]);
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toBe("cdDayOne");
    expect(stored[0]![1]).toMatch(/^[0-9]{13}$/);
    expect(Number(stored[0]![1])).toBeGreaterThanOrEqual(before);
    expect(Number(stored[0]![1])).toBeLessThanOrEqual(Date.now());
    /* blocked storage still opens the page, which then mounts as usual */
    const blocked: string[] = [];
    api.startDayOne({ sessionStorage: { setItem: () => { throw new Error("blocked"); } }, location: { assign: (p) => { blocked.push(p); } } });
    expect(blocked).toEqual(["/onboarding#day1"]);
    expect(writes.join("\n")).toBe("");
  });
});
