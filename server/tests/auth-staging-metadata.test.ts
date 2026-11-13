/* CD-117: the banner describes the runtime, not how the session was opened.
   Real auth routes and in-memory PGlite; email delivery alone is stubbed. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { buildApp } from "../src/app.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { hashPin } from "../src/routes/pin.js";
import { hashCode, sendEmail } from "../src/email.js";
import { createSession } from "../src/auth/sessions.js";
import { createLoginProof, LOGIN_PROOF_COOKIE } from "../src/auth/signin-guard.js";
import { registerAuthRoutes } from "../src/routes/auth.js";

vi.mock("../src/email.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/email.js")>(),
  sendEmail: vi.fn().mockResolvedValue("sent"),
}));

const HOST = "staging.currencydeskos.com";
const SERVICE = "currencydesk-staging.onrender.com";
const PREVIEW = "currencydesk-staging-pr-5.onrender.com";
let handle: DbHandle;
let app: FastifyInstance;
let session: Record<string, string>;

function cookiesOf(res: { cookies: { name: string; value: string }[] }) {
  const cookie = res.cookies.find((c) => c.name === "cdos_session");
  expect(cookie).toBeDefined();
  return { cdos_session: cookie!.value };
}

function stagingEnv() {
  vi.stubEnv("STAGING", "1");
  vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", HOST);
  vi.stubEnv("IS_PULL_REQUEST", undefined);
}

beforeAll(async () => {
  // Never inherit a connected database; this contract owns one disposable DB.
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("LEDGER_DATABASE_URL", undefined);
  vi.stubEnv("PGLITE_MEMORY", "1");
  vi.stubEnv("SEED_PASSWORD", "yorkville");
  stagingEnv();
  handle = await createDb();
  await seed(handle.db);
  await handle.db.update(schema.staffUsers).set({
    pinHash: await hashPin("4829"), pinMustChange: false, pinSetAt: new Date(),
  }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  // A synthetic ordinary email account, not the staging no-inbox exception.
  const [owner] = await handle.db.select().from(schema.staffUsers)
    .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`));
  if (!owner) throw new Error("Missing seeded owner");
  await handle.db.insert(schema.staffUsers).values({
    ...owner, id: `${DEMO.tenantId}:metadata@example.invalid`, staffId: "metadata@example.invalid",
  });
  app = await buildApp(handle.db);
  // Injection supplies a default Host, so remove it to exercise absence.
  app.addHook("onRequest", async (req) => {
    if (req.headers["x-test-no-host"] === "1") delete req.headers.host;
  });
  session = cookiesOf(await passwordLogin("/api/auth/login"));
});
beforeEach(stagingEnv);
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  try { await app?.close(); }
  finally {
    try { await handle?.close(); }
    finally { vi.unstubAllEnvs(); }
  }
});

async function passwordLogin(url: string) {
  const res = await app.inject({ method: "POST", url, headers: { host: HOST },
    payload: { staffId: "j.masri", password: DEMO.password } });
  expect(res.statusCode).toBe(200);
  expect(res.cookies.find((c) => c.name === "cdos_staging")?.value).toBe("");
  return res;
}

async function me(cookies = session, headers: Record<string, string> = { host: HOST }) {
  return app.inject({ method: "GET", url: "/api/auth/me", cookies, headers });
}

async function expectStagingAfterReload(cookies: Record<string, string>, staffId: string) {
  // Two independent HTTP reads with only the session cookie model boot/reload.
  // They do not claim a visual browser walkthrough.
  for (let read = 0; read < 2; read++) {
    const res = await me(cookies);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.json()).toMatchObject({ staging: true, user: { id: staffId } });
  }
  const live = await me({ ...cookies, cdos_staging: "1" }, {
    host: "currencydeskos.com", "x-forwarded-host": HOST,
  });
  expect(live.statusCode).toBe(200);
  expect(live.json().staging).toBe(false);
}

describe("staging metadata for every sign-in path", () => {
  it.each(["/api/auth/login", "/api/auth/login/start"])("password via %s survives reload without a marker", async (url) => {
    await expectStagingAfterReload(cookiesOf(await passwordLogin(url)), "j.masri");
  });

  it("PIN switch replaces the identity but retains staging metadata without a marker", async () => {
    // A session awaiting till selection exercises PIN authentication without
    // a ledger fixture. Till ownership/movement remains in auth-switch tests.
    const { token } = await createSession(handle.db, `${DEMO.tenantId}:j.masri`, { workspaceId: null });
    const original = { cdos_session: token };
    const switched = await app.inject({ method: "POST", url: "/api/auth/switch",
      headers: { host: HOST }, cookies: original, payload: { staffId: "m.costa", pin: "4829" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.cookies.find((c) => c.name === "cdos_staging")?.value).toBe("");
    expect((await me(original)).statusCode).toBe(401);
    await expectStagingAfterReload(cookiesOf(switched), "m.costa");
  });

  it("password plus emailed code yields the same metadata after verification and reload", async () => {
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start",
      headers: { host: HOST }, payload: { staffId: "metadata@example.invalid", password: DEMO.password } });
    expect(start.statusCode).toBe(200);
    expect(start.json().needsCode).toBe(true);
    expect(start.json().user).not.toHaveProperty("staging");
    expect(start.json()).not.toHaveProperty("code");
    expect(start.cookies.some((c) => c.name === "cdos_session")).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendEmail).mock.calls[0]![2];
    const text = typeof mail === "string" ? mail : mail.text;
    const code = text.match(/\b\d{6}\b/)?.[0];
    if (!code) throw new Error("No code in synthetic email");
    const verified = await app.inject({ method: "POST", url: "/api/auth/login/verify",
      headers: { host: HOST }, cookies: Object.fromEntries(start.cookies.map((c) => [c.name, c.value])),
      payload: { staffId: "metadata@example.invalid", code } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().user.staging).toBe(true);
    await expectStagingAfterReload(cookiesOf(verified), "metadata@example.invalid");
  });

  it("quick sign-in still works even when the marker is later absent", async () => {
    const entered = await app.inject({ method: "POST", url: "/api/staging/enter",
      headers: { host: HOST }, payload: { role: "teller" } });
    expect(entered.statusCode).toBe(200);
    expect(entered.cookies.find((c) => c.name === "cdos_staging")?.value).toBe("1");
    await expectStagingAfterReload(cookiesOf(entered), "m.costa");
  });
});

describe("metadata stays behind the existing runtime and raw Host gates", () => {
  it.each([HOST, SERVICE, "Staging.CurrencyDeskOS.com:443", `${HOST}.`])("recognizes %s without a cookie marker", async (host) => {
    const res = await me(session, { host, "x-forwarded-host": "currencydeskos.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json().staging).toBe(true);
  });

  it.each(["currencydeskos.com", "www.currencydeskos.com", "currencydesk.onrender.com",
    "currencydesk-pr-5.onrender.com", `${SERVICE}.evil.invalid`, "unknown.invalid"])(
    "refuses %s despite forged marker and forwarded hosts", async (host) => {
      const headers = { host, "x-forwarded-host": HOST, forwarded: `host=${HOST};proto=https` };
      const res = await me({ ...session, cdos_staging: "1" }, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json().staging).toBe(false);
      const enter = await app.inject({ method: "POST", url: "/api/staging/enter", headers, payload: { role: "administrator" } });
      expect(enter.statusCode).toBe(404);
      expect(enter.cookies.some((c) => c.name === "cdos_session")).toBe(false);
    });

  it("refuses a missing Host even when forwarded headers name staging", async () => {
    const res = await me({ ...session, cdos_staging: "1" }, {
      "x-test-no-host": "1", "x-forwarded-host": HOST, forwarded: `host=${HOST}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().staging).toBe(false);
  });

  it.each([undefined, "currencydeskos.com", "currencydesk.onrender.com"])("refuses process host %s despite a staging request and marker", async (host) => {
    vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", host);
    const res = await me({ ...session, cdos_staging: "1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().staging).toBe(false);
  });

  it.each([undefined, "0", "true", " 1", "1 "])("refuses flag %s despite staging hosts and marker", async (flag) => {
    vi.stubEnv("STAGING", flag);
    const res = await me({ ...session, cdos_staging: "1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().staging).toBe(false);
  });

  it("recognizes a staging preview only while IS_PULL_REQUEST is exactly true", async () => {
    vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", PREVIEW);
    for (const [flag, expected] of [[undefined, false], ["true", true], ["false", false]] as const) {
      vi.stubEnv("IS_PULL_REQUEST", flag);
      const res = await me(session, { host: PREVIEW });
      expect(res.statusCode).toBe(200);
      expect(res.json().staging).toBe(expected);
    }
  });

  it("does not turn the marker into authentication", async () => {
    const unauthenticated: Record<string, string>[] = [{ cdos_staging: "1" }, { cdos_staging: "1", cdos_session: "invalid" }];
    for (const cookies of unauthenticated) {
      const res = await me(cookies);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("ignores proxy-derived hostname even if a future caller enables trustProxy", async () => {
    const proxied = Fastify({ trustProxy: true });
    try {
      await proxied.register(cookie);
      let derivedHost = "";
      proxied.addHook("onRequest", async (req) => { derivedHost = req.hostname; });
      registerAuthRoutes(proxied, handle.db);
      const res = await proxied.inject({ method: "GET", url: "/api/auth/me",
        cookies: { ...session, cdos_staging: "1" },
        headers: { host: "currencydeskos.com", "x-forwarded-host": HOST } });
      expect(derivedHost).toBe(HOST);
      expect(res.statusCode).toBe(200);
      expect(res.json().staging).toBe(false);
    } finally { await proxied.close(); }
  });
});

// Check the immediate answers independently of /me: the browser consumes these
// before any reload/focus. The verify matrix uses a real stored password proof;
// the earlier email test covers creating that proof through login/start.
describe.each(["/api/auth/login", "/api/auth/login/start", "/api/auth/login/verify"])("immediate metadata at %s", (url) => {
  async function login(headers: Record<string, string>) {
    if (url === "/api/auth/login/verify") {
      const proof = await createLoginProof(handle.db, `${DEMO.tenantId}:metadata@example.invalid`, hashCode("482953"));
      return app.inject({ method: "POST", url, headers,
        cookies: { [LOGIN_PROOF_COOKIE]: proof.token },
        payload: { staffId: "metadata@example.invalid", code: "482953" } });
    }
    return app.inject({ method: "POST", url, headers,
      payload: { staffId: "j.masri", password: DEMO.password } });
  }
  it.each([
    { host: HOST, expected: true }, { host: SERVICE, expected: true },
    { host: "Staging.CurrencyDeskOS.com:443", expected: true }, { host: `${HOST}.`, expected: true },
    { host: "currencydeskos.com", expected: false }, { host: "www.currencydeskos.com", expected: false },
    { host: `${SERVICE}.evil.invalid`, expected: false },
  ])("labels raw Host $host as $expected", async ({ host, expected }) => {
    const res = await login({ host, "x-forwarded-host": HOST, forwarded: `host=${HOST}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.staging).toBe(expected);
  });
  it("does not label a missing Host", async () => {
    const res = await login({ host: HOST, "x-test-no-host": "1", "x-forwarded-host": HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.staging).toBe(false);
  });
  it.each([
    ["STAGING", undefined], ["STAGING", "true"], ["STAGING", "0"],
    ["RENDER_EXTERNAL_HOSTNAME", undefined], ["RENDER_EXTERNAL_HOSTNAME", "currencydeskos.com"],
  ])("fails closed for %s=%s", async (name, value) => {
    vi.stubEnv(name!, value);
    const res = await login({ host: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.staging).toBe(false);
  });
  it("requires the preview flag", async () => {
    vi.stubEnv("RENDER_EXTERNAL_HOSTNAME", PREVIEW);
    for (const [flag, expected] of [[undefined, false], ["true", true]] as const) {
      vi.stubEnv("IS_PULL_REQUEST", flag);
      const res = await login({ host: PREVIEW });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.staging).toBe(expected);
    }
  });
  it("does not label refused authentication", async () => {
    const res = await app.inject({ method: "POST", url, headers: { host: HOST },
      payload: url.endsWith("verify") ? { staffId: "metadata@example.invalid", code: "482953" }
        : { staffId: "absent-staff", password: "wrong-password" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty("staging");
    expect(res.json()).not.toHaveProperty("user");
  });
});
