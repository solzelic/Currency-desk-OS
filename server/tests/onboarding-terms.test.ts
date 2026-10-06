/* The invite link, then the terms, then setup.

   The reference in /onboarding/CD-XXXXXX is the application's own id.
   The first screen shows that. The next screen accepts the terms dated
   26 July 2026. Setup and launch both refuse until that acceptance is
   on the row, and a different version is refused with nothing stored. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { ONBOARDING_TERMS_UPDATED, ONBOARDING_TERMS_VERSION } from "../src/routes/onboarding-public.js";

let handle: DbHandle;
let app: FastifyInstance;
let adminCookie: Record<string, string> = {};
const ADMIN = "j.masri";

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

async function invite(email: string, name: string): Promise<{ reference: string; id: string }> {
  const applied = await app.inject({
    method: "POST", url: "/api/enquiries",
    payload: { kind: "early_access", email, name, details: { jurisdiction: "CA" } } as Record<string, unknown>,
  });
  expect(applied.statusCode).toBe(201);
  const reference = applied.json().reference as string;
  const row = (await handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)))[0]!;
  const invited = await app.inject({
    method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: adminCookie,
    payload: { status: "invited" } as Record<string, unknown>,
  });
  expect(invited.statusCode).toBe(200);
  return { reference, id: row.id };
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  adminCookie = cookieOf(await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" },
  }));
});

afterAll(async () => {
  await app.close();
  await handle.close();
  vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("the ID on the invite link", () => {
  it("is the application reference already in the link, not a second id", async () => {
    const { reference } = await invite("ida@quay.example", "Ida Quay");
    const state = await app.inject({ method: "GET", url: `/api/onboarding/${reference}/state` });
    expect(state.statusCode).toBe(200);
    expect(state.json().application.reference).toBe(reference);
    expect(state.json().terms.accepted).toBe(false);
    expect(state.json().terms.version).toBe(ONBOARDING_TERMS_VERSION);
    expect(state.json().terms.updated).toBe(ONBOARDING_TERMS_UPDATED);
    expect(state.json().terms.href).toBe("/legal#terms");

    const page = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/onboarding.html"),
      "utf8",
    );
    expect(page).toContain("This is your ID");
    expect(page).toContain("data-issued-id");
    expect(page).toContain('termsVersion: "2026-07-26"');
    expect(page).not.toContain("/api/onboarding/account");
  });
});

describe("terms before setup", () => {
  it("refuses setup until the 26 July 2026 terms are accepted for that reference", async () => {
    const { reference, id } = await invite("terms@quay.example", "Tess Quay");
    const blocked = await app.inject({
      method: "PUT", url: `/api/onboarding/${reference}/state`,
      payload: { at: 1, data: { operatingName: "Quay Exchange" } } as Record<string, unknown>,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("terms_required");

    const accepted = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/terms`,
      payload: { termsAccepted: true, termsVersion: ONBOARDING_TERMS_VERSION },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().ok).toBe(true);

    const row = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, id)))[0]!;
    expect(row.termsVersion).toBe(ONBOARDING_TERMS_VERSION);
    expect(row.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row.termsAcceptedBy).toBe("terms@quay.example");

    const saved = await app.inject({
      method: "PUT", url: `/api/onboarding/${reference}/state`,
      payload: { at: 1, data: { operatingName: "Quay Exchange", termsChecked: true } } as Record<string, unknown>,
    });
    expect(saved.statusCode).toBe(200);
    const again = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, id)))[0]!;
    expect((again.answers as Record<string, unknown>).termsChecked).toBeUndefined();
    expect((again.answers as Record<string, unknown>).operatingName).toBe("Quay Exchange");

    const repeat = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/terms`,
      payload: { termsAccepted: true, termsVersion: ONBOARDING_TERMS_VERSION },
    });
    expect(repeat.json().already).toBe(true);
    const kept = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, id)))[0]!;
    expect(kept.termsAcceptedAt?.getTime()).toBe(row.termsAcceptedAt?.getTime());
    expect(kept.termsAcceptedBy).toBe("terms@quay.example");
  });

  it("refuses launch until those terms are on the row", async () => {
    const { reference } = await invite("launch@quay.example", "Lee Quay");
    const launch = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/launch`,
      payload: { data: { ownerPass: "northyork2019" } } as Record<string, unknown>,
    });
    expect(launch.statusCode).toBe(403);
    expect(launch.json().error).toBe("terms_required");
    const desks = await handle.db.select().from(schema.tenants);
    expect(desks.some((t) => t.name === "Lee Quay")).toBe(false);
  });

  it("refuses any other version, and stores nothing", async () => {
    const { reference, id } = await invite("version@quay.example", "Vera Quay");
    const wrong = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/terms`,
      payload: { termsAccepted: true, termsVersion: "1999-01-01" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("invalid_terms");

    const named = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/terms`,
      payload: { termsAccepted: true, termsVersion: ONBOARDING_TERMS_VERSION, acceptedBy: "someone-else@example.com" },
    });
    expect(named.statusCode).toBe(400);

    const row = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, id)))[0];
    expect(row?.termsVersion ?? null).toBeNull();
    expect(row?.termsAcceptedAt ?? null).toBeNull();
    expect(row?.termsAcceptedBy ?? null).toBeNull();

    const ok = await app.inject({
      method: "POST", url: `/api/onboarding/${reference}/terms`,
      payload: { termsAccepted: true, termsVersion: ONBOARDING_TERMS_VERSION },
    });
    expect(ok.statusCode).toBe(200);

    /* A direct write of another version has to fail in the database,
       not only in the route. Drizzle wraps the Postgres error; the
       constraint name is on the cause. */
    let refused = false;
    try {
      await handle.db.update(schema.onboarding).set({ termsVersion: "1999-01-01" }).where(eq(schema.onboarding.enquiryId, id));
    } catch (err) {
      refused = true;
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      expect(`${cause?.code ?? ""} ${cause?.message ?? ""}`).toMatch(/23514|onboarding_terms_recorded/);
    }
    expect(refused).toBe(true);
    const kept = (await handle.db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, id)))[0]!;
    expect(kept.termsVersion).toBe(ONBOARDING_TERMS_VERSION);
    expect(kept.termsAcceptedBy).toBe("version@quay.example");
  });
});
