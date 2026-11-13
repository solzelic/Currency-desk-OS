/* Is this shop address free? (Early Access v2.1, step 2; CD-178.)

   The application asks for the shop's address on CurrencyDesk,
   `<slug>.currencydeskos.com`, and checks it while the person types. The
   page used to say "is available" whatever was typed. This is the real
   check: an address is taken when a desk uses it, when a sign-up in
   progress holds it, or when another application already asked for it,
   and a reserved word is never free. The answer carries up to three
   free alternatives, the way the design offers them. One list of
   reserved words serves the check, sign-up and desk creation; they had
   drifted apart. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { isReservedSlug } from "../src/onboarding/reserved-slugs.js";
import { resetWorkspaceThrottle, WORKSPACE_CHECKS_PER_MINUTE } from "../src/routes/workspaces.js";

let handle: DbHandle;
let app: FastifyInstance;

const check = (slug: string, ip = "203.0.113.7") =>
  app.inject({ method: "GET", url: `/api/workspaces/${encodeURIComponent(slug)}`, remoteAddress: ip });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  /* Held by a sign-up in progress, and by two applications: one live,
     one declined (a declined application holds nothing). */
  await handle.db.insert(schema.pendingSignups).values({
    id: "ps-held", email: "held@example.com", businessName: "Held FX", ownerName: "Owner",
    passwordHash: "x", slug: "held-fx", codeHash: "x", expiresAt: new Date(Date.now() + 600_000),
  });
  await handle.db.insert(schema.enquiries).values([
    { id: "enq-asked", reference: "CD-ASKED1", kind: "early_access", email: "asked@example.com", details: { workspace: "maple-money.currencydeskos.com" } },
    { id: "enq-gone", reference: "CD-GONE01", kind: "early_access", email: "gone@example.com", status: "declined", details: { workspace: "old-name.currencydeskos.com" } },
  ]);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => resetWorkspaceThrottle());

describe("GET /api/workspaces/:slug", () => {
  it("says a free address is available, never stored, with free alternatives", async () => {
    const res = await check("northside-cambio");
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers["cache-control"])).toMatch(/no-store/);
    const body = res.json() as { available: boolean; slug: string; suggestions: string[] };
    expect(body.available).toBe(true);
    expect(body.slug).toBe("northside-cambio");
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions.length).toBeLessThanOrEqual(3);
    expect(body.suggestions).not.toContain("northside-cambio");
  });

  it("reads the address the way it will be stored: trimmed and lower case", async () => {
    const body = (await check("  NorthSide-Cambio ")).json();
    expect(body).toMatchObject({ available: true, slug: "northside-cambio" });
  });

  it("is taken when a desk already uses it", async () => {
    const body = (await check("yorkfx")).json();
    expect(body.available).toBe(false);
  });

  it("is taken when a sign-up in progress holds it", async () => {
    expect((await check("held-fx")).json().available).toBe(false);
  });

  it("is taken when another application asked for it, and free again when that application was declined", async () => {
    expect((await check("maple-money")).json().available).toBe(false);
    expect((await check("old-name")).json().available).toBe(true);
  });

  it("never offers a reserved word, and never suggests a taken address", async () => {
    for (const word of ["admin", "api", "onboarding", "signup", "early-access"]) {
      expect((await check(word)).json().available, word).toBe(false);
    }
    const body = (await check("held")).json() as { suggestions: string[] };
    for (const idea of body.suggestions) {
      expect((await check(idea)).json().available, idea).toBe(true);
      resetWorkspaceThrottle();
    }
  });

  it("offers alternatives the design's way: joined words, -exchange, initials plus fx", async () => {
    const body = (await check("maple-money")).json() as { suggestions: string[] };
    expect(body.suggestions).toEqual(["maplemoney", "maple-money-exchange", "mmfx"]);
  });

  it("refuses an address that cannot be one", async () => {
    for (const bad of ["a", "-maple", "maple-", "maple_money", "x".repeat(41)]) {
      const res = await check(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error).toBe("invalid_slug");
    }
  });

  it("slows down one address that checks too often, and not another", async () => {
    for (let i = 0; i < WORKSPACE_CHECKS_PER_MINUTE; i++) {
      expect((await check(`shop-${i}`, "198.51.100.9")).statusCode).toBe(200);
    }
    const over = await check("one-more", "198.51.100.9");
    expect(over.statusCode).toBe(429);
    expect((await check("one-more", "198.51.100.10")).statusCode).toBe(200);
  });
});

describe("one list of reserved words", () => {
  it("covers what sign-up refused and what desk creation refused", () => {
    for (const word of ["api", "app", "www", "sites", "admin", "currencydesk", "signup", "login", "onboarding", "status"]) {
      expect(isReservedSlug(word), word).toBe(true);
    }
    expect(isReservedSlug("maple-money")).toBe(false);
  });

  it("sign-up now refuses an address only desk creation used to refuse", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/signup",
      payload: { businessName: "Onboarding FX", ownerName: "Owner", email: "reserved@example.com", password: "a-strong-pass", slug: "onboarding" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("slug_reserved");
  });
});
