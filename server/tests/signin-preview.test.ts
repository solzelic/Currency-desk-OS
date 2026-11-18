/* CD-277. Flags off leaves /login untouched and makes no new call.
   The design preview is host-gated and does not sign anyone in. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { anySignInFlag, readSignInFlags } from "../src/auth/signin-flags.js";
import { signInPreviewHostAllowed } from "../src/routes/signin-preview.js";

const require = createRequire(import.meta.url);
const adapter = require("../../os-src/signin-adapter.js") as {
  flagsFromWindow: (w: unknown) => { passkey: boolean; google: boolean; microsoft: boolean };
  anyOn: (flags: { passkey: boolean; google: boolean; microsoft: boolean }) => boolean;
  openPasswordStep: (email: string) => boolean;
  removalBlocked: (methods: { id: string; connected: boolean }[], id: string) => boolean;
  createSignInAdapter: () => {
    continueWithPasskey: () => Promise<{ status: string }>;
    continueWithGoogle: () => Promise<{ status: string }>;
    continueWithMicrosoft: () => Promise<{ status: string }>;
    sendSignInLink: () => Promise<{ status: string }>;
  };
};

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const saved = {
  STATIC_DIR: process.env.STATIC_DIR,
  PASSKEY: process.env.SIGNIN_PASSKEY,
  GOOGLE: process.env.SIGNIN_GOOGLE,
  MICROSOFT: process.env.SIGNIN_MICROSOFT,
};

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.SIGNIN_PASSKEY;
  delete process.env.SIGNIN_GOOGLE;
  delete process.env.SIGNIN_MICROSOFT;
  process.env.PGLITE_MEMORY = "1";
  process.env.STATIC_DIR = ROOT;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  if (saved.STATIC_DIR == null) delete process.env.STATIC_DIR;
  else process.env.STATIC_DIR = saved.STATIC_DIR;
  for (const [key, value] of [
    ["SIGNIN_PASSKEY", saved.PASSKEY],
    ["SIGNIN_GOOGLE", saved.GOOGLE],
    ["SIGNIN_MICROSOFT", saved.MICROSOFT],
  ] as const) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sign-in flags", () => {
  it("reads the three switches as off unless they are exactly on", () => {
    expect(readSignInFlags({})).toEqual({ passkey: false, google: false, microsoft: false });
    expect(anySignInFlag(readSignInFlags({ SIGNIN_PASSKEY: "0", SIGNIN_GOOGLE: "false", SIGNIN_MICROSOFT: "" }))).toBe(false);
    expect(readSignInFlags({ SIGNIN_GOOGLE: "1" })).toEqual({ passkey: false, google: true, microsoft: false });
    expect(readSignInFlags({ SIGNIN_PASSKEY: "yes", SIGNIN_MICROSOFT: "on" })).toMatchObject({ passkey: true, microsoft: true });
  });

  it("does not change /login while every flag is off", async () => {
    delete process.env.SIGNIN_PASSKEY;
    delete process.env.SIGNIN_GOOGLE;
    delete process.env.SIGNIN_MICROSOFT;
    const file = readFileSync(path.join(ROOT, "web/app/index.html"), "utf8");
    const res = await app.inject({ method: "GET", url: "/login", headers: { host: "localhost" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(file);
    expect(res.body).not.toContain("signInFlags");
    expect(res.body).not.toContain("Continue with Google");
    expect(res.body).not.toContain("Continue with a passkey");
  });

  it("puts the flags on the desk shell only when one is on", async () => {
    process.env.SIGNIN_GOOGLE = "1";
    delete process.env.SIGNIN_PASSKEY;
    delete process.env.SIGNIN_MICROSOFT;
    const res = await app.inject({ method: "GET", url: "/login", headers: { host: "localhost" } });
    expect(res.body).toContain('"google":true');
    expect(res.body).toContain('"passkey":false');
    expect(res.body).toContain('"microsoft":false');
    expect(res.headers["cache-control"]).toBe("no-store");
    delete process.env.SIGNIN_GOOGLE;
  });
});

describe("the password step opens before any lookup", () => {
  it("opens for every non-empty email and never calls fetch", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error("fetch");
    }) as typeof fetch;
    try {
      expect(adapter.openPasswordStep("no-such-person@example.com")).toBe(true);
      expect(adapter.openPasswordStep("  also-missing@example.com  ")).toBe(true);
      expect(adapter.openPasswordStep("")).toBe(false);
      expect(adapter.openPasswordStep("   ")).toBe(false);
      expect(adapter.flagsFromWindow(undefined)).toEqual({ passkey: false, google: false, microsoft: false });
      expect(adapter.anyOn(adapter.flagsFromWindow({ CDOS: {} }))).toBe(false);
      const stubs = adapter.createSignInAdapter();
      expect(await stubs.continueWithPasskey()).toEqual({ status: "not_available" });
      expect(await stubs.continueWithGoogle()).toEqual({ status: "not_available" });
      expect(await stubs.continueWithMicrosoft()).toEqual({ status: "not_available" });
      expect(await stubs.sendSignInLink()).toEqual({ status: "not_available" });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the email continue handler free of a request", () => {
    const src = readFileSync(path.join(ROOT, "os-src/cdos-signin-methods.jsx"), "utf8");
    const start = src.indexOf("function continueWithEmail");
    const end = src.indexOf("const CSS");
    const fn = src.slice(start, end);
    expect(fn).toContain("openPasswordStep");
    expect(fn).not.toContain("fetch");
    expect(fn).not.toContain("/api/");
    const signIn = readFileSync(path.join(ROOT, "os-src/cdos-signin.jsx"), "utf8");
    const wrapper = signIn.slice(signIn.indexOf("function SignIn(props)"), signIn.indexOf("window.CDOS.SignIn = SignIn"));
    expect(wrapper).toContain("anyOn(flags)");
    expect(wrapper).toContain("SignInMethods");
    expect(wrapper).not.toContain("fetch(");
  });

  it("will not remove the last sign-in method", () => {
    const methods = [
      { id: "passkey", connected: false },
      { id: "google", connected: false },
      { id: "email", connected: true },
    ];
    expect(adapter.removalBlocked(methods, "email")).toBe(true);
    expect(adapter.removalBlocked(methods, "google")).toBe(false);
    expect(adapter.removalBlocked([{ id: "email", connected: true }, { id: "google", connected: true }], "email")).toBe(false);
  });
});

describe("design preview host gate", () => {
  it("allows the staging host and localhost only", () => {
    expect(signInPreviewHostAllowed("currencydesk-staging.onrender.com")).toBe(true);
    expect(signInPreviewHostAllowed("localhost:4173")).toBe(true);
    expect(signInPreviewHostAllowed("127.0.0.1")).toBe(true);
    expect(signInPreviewHostAllowed("[::1]")).toBe(true);
    expect(signInPreviewHostAllowed("www.currencydeskos.com")).toBe(false);
    expect(signInPreviewHostAllowed("currencydeskos.com")).toBe(false);
    expect(signInPreviewHostAllowed("example.com")).toBe(false);
    expect(signInPreviewHostAllowed("currencydesk-staging.onrender.com.evil.test")).toBe(false);
    expect(signInPreviewHostAllowed(undefined)).toBe(false);
  });

  it("serves the gallery on the staging host and localhost, and 404s everywhere else", async () => {
    for (const host of ["currencydesk-staging.onrender.com", "localhost", "127.0.0.1"]) {
      const page = await app.inject({ method: "GET", url: "/design-preview/signin", headers: { host } });
      expect(page.statusCode, host).toBe(200);
      expect(page.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(page.body).toContain('content="noindex, nofollow"');
      expect(page.body).toContain("/design-preview/signin/a");
      expect(page.body).not.toContain("/api/auth");
      const state = await app.inject({ method: "GET", url: "/design-preview/signin/b", headers: { host } });
      expect(state.statusCode, host).toBe(200);
      expect(state.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(state.body).toContain("/web/app/signin-preview.js");
      expect(state.body).not.toContain("/api/auth");
    }
    const forwarded = await app.inject({
      method: "GET",
      url: "/design-preview/signin",
      headers: { host: "www.currencydeskos.com", "x-forwarded-host": "currencydesk-staging.onrender.com" },
    });
    expect(forwarded.statusCode).toBe(404);
    expect(forwarded.json()).toEqual({ error: "not_found" });
    for (const host of ["www.currencydeskos.com", "currencydeskos.com", "example.com"]) {
      const res = await app.inject({ method: "GET", url: "/design-preview/signin/a", headers: { host } });
      expect(res.statusCode, host).toBe(404);
      expect(res.body).not.toContain("Sign-in preview");
      expect(res.json()).toEqual({ error: "not_found" });
    }
    const unknown = await app.inject({ method: "GET", url: "/design-preview/signin/nope", headers: { host: "localhost" } });
    expect(unknown.statusCode).toBe(404);
  });
});
