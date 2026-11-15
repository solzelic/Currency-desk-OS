import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { resetIdDoor } from "../src/routes/onboarding-public.js";
import { hashCode, sendEmail } from "../src/email.js";
let handle: DbHandle;
let app: Awaited<ReturnType<typeof buildApp>>;
let logs = "";
const email = "private-owner@example.test";
const reference = "CD-LEGACY-PRIVATE";
beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await handle.db.insert(schema.enquiries).values({ id: randomUUID(), reference, cdId: "CD-YORK-7K42", kind: "early_access", status: "invited", email, name: "Private Owner", details: { shopName: "Synthetic" } });
  await handle.db.insert(schema.pendingSignups).values({ id: randomUUID(), email, businessName: "Synthetic", ownerName: "Private", passwordHash: "unused", slug: "private-reservation", codeHash: hashCode("123456"), expiresAt: new Date(Date.now() + 60_000) });
  app = await buildApp(handle.db, {}, new Writable({ write(chunk, _encoding, callback) { logs += String(chunk); callback(); } }));
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => { resetIdDoor(); logs = ""; });
it("the old reference cannot disclose or modify a v2.1 reservation", async () => {
  for (const [method, tail, payload] of [
    ["GET", "state", undefined], ["PUT", "state", { answers: { operatingName: "Attacker" } }],
    ["POST", "verify/send", {}], ["POST", "launch", {}],
  ] as const) {
    const res = await app.inject({ method, url: `/api/onboarding/${reference}/${tail}`, payload });
    expect(res.statusCode, `${method} ${tail}: ${res.body}`).toBe(404);
    expect(res.body).not.toContain(email);
    expect(res.body).not.toContain("Private Owner");
  }
});
it("plain signup cannot create or verify a v2.1 reservation, even with a stale pending code", async () => {
  const res = await app.inject({ method: "POST", url: "/api/signup", payload: { email, businessName: "Synthetic", ownerName: "Private", password: "long enough password", slug: "new-private-reservation" } });
  expect(res.statusCode).toBe(403);
  const verify = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email, code: "123456" } });
  expect(verify.statusCode).toBe(404);
});
it("request logs strip compact identifiers and query secrets", async () => {
  await app.inject({ method: "GET", url: "/api/onboarding/york7k42/state?code=PRIVATE_PROVIDER_CODE&email=private%40example.test" });
  expect(logs).not.toContain("york7k42");
  expect(logs).not.toContain("PRIVATE_PROVIDER_CODE");
  expect(logs).not.toContain("private%40example.test");
});
it("sensitive email never simulates a secret in logs", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const result = await sendEmail(email, "Code", { text: "SECRET_123456", sensitive: true } as Parameters<typeof sendEmail>[2]);
  expect(result).toBe("failed");
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
