import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "../src/db/index.js";
import { registerSignupPages, seedAllowed } from "../src/routes/signup-page.js";
import { testMailbox, openTestMailbox } from "../src/email-test-mailbox.js";
const flags = { SIGNUP_TEST_SEED: "1", CD_TEST_MAILBOX: "1", NODE_ENV: "development" };
for (const unsafe of [
  { NODE_ENV: "production" }, { NODE_ENV: "staging" }, { NODE_ENV: "" }, { STAGING: "1" }, { STAGING: "true" },
  { RENDER: "true" }, { RENDER_SERVICE_ID: "synthetic-service" }, { RENDER_EXTERNAL_HOSTNAME: "staging.example.test" },
  { HOST: "0.0.0.0" }, { HOST: "::" }, { HOST: "staging.example.test" },
  { DATABASE_URL: "postgresql://test@remote.example.test/disposable" },
  { DATABASE_URL: "postgresql://test@localhost/disposable?host=remote.example.test" },
  { DATABASE_URL: "postgresql:///disposable", PGHOST: "remote.example.test" },
]) it(`refuses seed and mailbox under ${Object.keys(unsafe).join('/')}`, async () => {
  const env = { ...flags, ...unsafe }; expect(seedAllowed(env)).toBe(false);
  const app = Fastify(); expect(openTestMailbox(app, env)).toBe(false);
  expect((await app.inject({ method: "GET", url: "/__test/mail?to=synthetic@example.test" })).statusCode).toBe(404);
  await app.close();
});
it("allows an explicitly local disposable test runtime", () => {
  expect(seedAllowed({ ...flags, NODE_ENV: "test", HOST: "127.0.0.1", DATABASE_URL: "postgresql://test@127.0.0.1:5432/disposable" })).toBe(true);
});
it("a local mailbox still refuses non-loopback request addresses and hosts", async () => {
  const app = Fastify(); expect(openTestMailbox(app, { ...flags, HOST: "127.0.0.1" })).toBe(true);
  expect((await app.inject({ method: "GET", url: "/__test/mail?to=synthetic@example.test", remoteAddress: "203.0.113.8", headers: { host: "localhost" } })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/__test/mail?to=synthetic@example.test", headers: { host: "staging.example.test" } })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/__test/mail?to=synthetic@example.test", headers: { host: "localhost" } })).statusCode).toBe(200);
  await app.close();
});

it("page seeding requires local runtime and request, and closing removes mailbox secrets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "signup-local-"));
  mkdirSync(path.join(root, "web")); writeFileSync(path.join(root, "web/signup.html"), "<html><head></head></html>");
  const app = Fastify(); app.decorateReply("sendFile", function () { return this.send("unseeded"); });
  vi.stubEnv("SIGNUP_TEST_SEED", "1"); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("STAGING", "0"); vi.stubEnv("HOST", "127.0.0.1");
  try {
    // Bare page never consults DB. A DB call would be an error, not mocked data.
    registerSignupPages(app, null as unknown as Db, root, { signup: true, legacy: false, sso: false });
    expect((await app.inject({ url: "/onboarding?step=pay", headers: { host: "localhost" } })).body).toContain('__cdSeedStep="pay"');
    expect((await app.inject({ url: "/onboarding?step=pay", remoteAddress: "203.0.113.8", headers: { host: "localhost" } })).body).toBe("unseeded");
    expect((await app.inject({ url: "/onboarding?step=pay", headers: { host: "staging.example.test" } })).body).toBe("unseeded");
    vi.stubEnv("STAGING", "1");
    expect((await app.inject({ url: "/onboarding?step=pay", headers: { host: "localhost" } })).body).toBe("unseeded");
  } finally { await app.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  const mailbox = Fastify(); const env = { ...flags };
  expect(openTestMailbox(mailbox, env)).toBe(true); expect(testMailbox()).not.toBeNull();
  env.NODE_ENV = "production"; expect(testMailbox()).toBeNull();
  await mailbox.close(); expect(testMailbox()).toBeNull();
});
