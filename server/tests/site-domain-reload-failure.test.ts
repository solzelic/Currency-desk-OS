/* A failed map reload must not undo the save or drop the audit row. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const gate = vi.hoisted(() => ({ failReload: false }));

vi.mock("../src/sites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites.js")>();
  return {
    ...actual,
    refreshSiteDomains: async (db: Parameters<typeof actual.refreshSiteDomains>[0]) => {
      if (gate.failReload) throw new Error("reload down");
      return actual.refreshSiteDomains(db);
    },
  };
});

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  gate.failReload = false;
  await app.close();
  await handle.close();
});

describe("domain reload failure", () => {
  it("returns 200 and keeps the audit row when the reload throws", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    const cookie = login.cookies.find((item) => item.name === "cdos_session");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gate.failReload = true;
    try {
      const saved = await app.inject({
        method: "PATCH",
        url: "/api/tenant",
        cookies: cookie ? { cdos_session: cookie.value } : {},
        payload: { siteDomain: "audit-first.example" },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().tenant.siteDomain).toBe("audit-first.example");
      expect(warn).toHaveBeenCalledWith("[site-domains] refresh failed: reload down");
    } finally {
      gate.failReload = false;
      warn.mockRestore();
    }

    const events = await handle.db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "tenant.site_domain_changed"));
    expect(events.map((row) => row.detail.domain)).toContain("audit-first.example");
  });
});
