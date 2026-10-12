/* Platform writes name a permission.

   An auditor is on the team and can read. They cannot suspend or delete
   a desk, change a plan, create a desk, reset a credential, invite a
   shop, or edit an application. The role that holds the need still can.
   On main these routes call gate() with no need, so the auditor's 403
   does not hold. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { hashPassword } from "../src/auth/password.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
const PASS = "platform-pass-1";
const ENQ = "enq-write-gate";

type Cookies = Record<string, string>;
type Role = "auditor" | "support" | "security" | "billing";
const sessions: Record<Role | "owner", Cookies> = {
  auditor: {}, support: {}, security: {}, billing: {}, owner: {},
};

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Cookies => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("no session cookie");
  return { cdos_session: c.value };
};

const call = (who: Cookies, method: NonNullable<InjectOptions["method"]>, url: string, payload?: unknown) =>
  app.inject({ method, url, cookies: who, payload: payload as InjectOptions["payload"] });

const denied = async (res: Awaited<ReturnType<typeof call>>) => {
  expect({ status: res.statusCode, error: res.json().error }).toEqual({ status: 403, error: "permission_denied" });
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb();
  await seed(handle.db);
  const passwordHash = await hashPassword(PASS);
  const add = async (email: string, role: Role) => {
    await handle.db.insert(schema.staffUsers).values({
      id: `${DEMO.tenantId}:${email}`,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      staffId: email,
      name: role,
      role: "administrator",
      authorizedBranchIds: [DEMO.branchId],
      passwordHash,
    });
    await handle.db.insert(schema.platformUsers).values({
      email, name: role, role, status: "active", addedBy: "test",
    });
  };
  /* Staff ids that are not addresses sign in on the password alone.
     An address is sent through the emailed-code door, which is a
     different test. The platform row is keyed by that same staff id. */
  await add("auditor.desk", "auditor");
  await add("support.desk", "support");
  await add("security.desk", "security");
  await add("billing.desk", "billing");
  await handle.db.insert(schema.platformUsers).values({
    email: "j.masri", name: "J. Masri", role: "owner", status: "active", addedBy: "test",
  });
  await handle.db.insert(schema.enquiries).values({
    id: ENQ, reference: "CD-GATE01", kind: "early_access",
    email: "applicant-gate@example.com", name: "Ada Applicant", status: "reviewing",
  });
  app = await buildApp(handle.db);
  const sign = async (staffId: string, password: string) => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { staffId, password, tenantId: DEMO.tenantId },
    });
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
  };
  sessions.auditor = await sign("auditor.desk", PASS);
  sessions.support = await sign("support.desk", PASS);
  sessions.security = await sign("security.desk", PASS);
  sessions.billing = await sign("billing.desk", PASS);
  sessions.owner = await sign("j.masri", DEMO.password);
  /* The owner can create on main and after the gate. Later cases use
     these desks, so an auditor denial is a 403 rather than a 404
     left behind by an earlier failure. */
  for (const slug of ["gatedesk", "bothdesk"]) {
    const created = await call(sessions.owner, "POST", "/api/admin/tenants", deskBody(slug, `o@${slug}.example`));
    expect(created.statusCode).toBe(201);
  }
});

afterAll(async () => {
  await app.close();
  await handle.close();
  vi.restoreAllMocks();
  delete process.env.PGLITE_MEMORY;
  delete process.env.SEED_PASSWORD;
});

const tenant = (id: string) =>
  handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1).then((rows) => rows[0]);
const person = (staffId: string) =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(1).then((rows) => rows[0]!);
const enquiry = () =>
  handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.id, ENQ)).limit(1).then((rows) => rows[0]!);
const byEmail = (email: string) =>
  handle.db.select().from(schema.enquiries).where(eq(schema.enquiries.email, email)).limit(1).then((rows) => rows[0]);

const deskBody = (slug: string, email: string) => ({
  businessName: slug, ownerName: "Owner", ownerEmail: email,
  slug, plan: "basic", password: "a-strong-pass",
});

describe("platform write routes name a need", () => {
  it("lets an auditor read, and refuses a stranger", async () => {
    const me = await app.inject({ method: "GET", url: "/api/admin/me", cookies: sessions.auditor });
    expect(me.json()).toMatchObject({ isAdmin: true, role: "auditor" });
    expect((await app.inject({ method: "GET", url: "/api/admin/tenants", cookies: sessions.auditor })).statusCode).toBe(200);
    const stranger = await call({}, "PATCH", "/api/admin/tenants/tnt-yorkfx", { suspended: true });
    expect(stranger.statusCode).toBe(401);
  });

  it("refuses an auditor and billing from creating a desk, and lets support and security create one", async () => {
    await denied(await call(sessions.auditor, "POST", "/api/admin/tenants", deskBody("auditenant", "a@auditenant.example")));
    expect(await tenant("tnt-auditenant")).toBeUndefined();
    await denied(await call(sessions.billing, "POST", "/api/admin/tenants", deskBody("billtenant", "b@billtenant.example")));
    expect(await tenant("tnt-billtenant")).toBeUndefined();
    const support = await call(sessions.support, "POST", "/api/admin/tenants", deskBody("supportdesk", "o@supportdesk.example"));
    expect(support.statusCode).toBe(201);
    expect(await tenant("tnt-supportdesk")).toMatchObject({ plan: "basic", suspended: false });
    const security = await call(sessions.security, "POST", "/api/admin/tenants", deskBody("secdesk", "o@secdesk.example"));
    expect(security.statusCode).toBe(201);
    expect(await tenant("tnt-secdesk")).toBeTruthy();
  });

  it("lets billing change a plan, and refuses auditor, support, and security", async () => {
    for (const who of [sessions.auditor, sessions.support, sessions.security]) {
      await denied(await call(who, "PATCH", "/api/admin/tenants/tnt-gatedesk", { plan: "premium" }));
      expect((await tenant("tnt-gatedesk"))!.plan).toBe("basic");
    }
    const ok = await call(sessions.billing, "PATCH", "/api/admin/tenants/tnt-gatedesk", { plan: "premium" });
    expect(ok.statusCode).toBe(200);
    expect((await tenant("tnt-gatedesk"))!.plan).toBe("premium");
  });

  it("lets security suspend a desk, and refuses auditor, support, and billing", async () => {
    for (const who of [sessions.auditor, sessions.support, sessions.billing]) {
      await denied(await call(who, "PATCH", "/api/admin/tenants/tnt-gatedesk", { suspended: true }));
      expect((await tenant("tnt-gatedesk"))!.suspended).toBe(false);
    }
    const ok = await call(sessions.security, "PATCH", "/api/admin/tenants/tnt-gatedesk", { suspended: true });
    expect(ok.statusCode).toBe(200);
    expect((await tenant("tnt-gatedesk"))!.suspended).toBe(true);
  });

  it("requires both needs when one body suspends and changes the plan", async () => {
    const before = await tenant("tnt-bothdesk");
    await denied(await call(sessions.security, "PATCH", "/api/admin/tenants/tnt-bothdesk", { suspended: true, plan: "pro" }));
    await denied(await call(sessions.billing, "PATCH", "/api/admin/tenants/tnt-bothdesk", { suspended: true, plan: "pro" }));
    expect(await tenant("tnt-bothdesk")).toMatchObject({ plan: before!.plan, suspended: before!.suspended });
    const ok = await call(sessions.owner, "PATCH", "/api/admin/tenants/tnt-bothdesk", { suspended: true, plan: "pro" });
    expect(ok.statusCode).toBe(200);
    expect(await tenant("tnt-bothdesk")).toMatchObject({ plan: "pro", suspended: true });
  });

  it("lets security delete a suspended desk, and refuses auditor and support", async () => {
    await denied(await call(sessions.auditor, "DELETE", "/api/admin/tenants/tnt-gatedesk"));
    await denied(await call(sessions.support, "DELETE", "/api/admin/tenants/tnt-gatedesk"));
    expect(await tenant("tnt-gatedesk")).toBeTruthy();
    const ok = await call(sessions.security, "DELETE", "/api/admin/tenants/tnt-gatedesk");
    expect(ok.statusCode).toBe(200);
    expect(await tenant("tnt-gatedesk")).toBeUndefined();
  });

  it("lets support act on a person, and refuses an auditor and billing", async () => {
    const costa = await person("m.costa");
    await denied(await call(sessions.auditor, "PATCH", `/api/admin/staff/${costa.id}`, { active: false }));
    await denied(await call(sessions.billing, "PATCH", `/api/admin/staff/${costa.id}`, { active: false }));
    expect((await person("m.costa")).active).toBe(true);
    expect((await call(sessions.support, "PATCH", `/api/admin/staff/${costa.id}`, { active: false })).statusCode).toBe(200);
    expect((await person("m.costa")).active).toBe(false);

    const haddad = await person("r.haddad");
    const hash = haddad.passwordHash;
    await denied(await call(sessions.auditor, "POST", `/api/admin/staff/${haddad.id}/reset-password`));
    await denied(await call(sessions.billing, "POST", `/api/admin/staff/${haddad.id}/reset-password`));
    expect((await person("r.haddad")).passwordHash).toBe(hash);
    const reset = await call(sessions.support, "POST", `/api/admin/staff/${haddad.id}/reset-password`);
    expect(reset.statusCode).toBe(200);
    expect(reset.json().tempPassword).toEqual(expect.any(String));
    expect((await person("r.haddad")).passwordHash).not.toBe(hash);

    const singh = await person("a.singh");
    await denied(await call(sessions.auditor, "POST", `/api/admin/staff/${singh.id}/reset-pin`));
    expect((await person("a.singh")).pinHash).toBeNull();
    const pin = await call(sessions.support, "POST", `/api/admin/staff/${singh.id}/reset-pin`);
    expect(pin.statusCode).toBe(200);
    expect(pin.json().pin).toEqual(expect.any(String));
    expect((await person("a.singh")).pinHash).toEqual(expect.any(String));

    const iqbal = await person("s.iqbal");
    await denied(await call(sessions.auditor, "POST", `/api/admin/staff/${iqbal.id}/cd-id`));
    expect((await person("s.iqbal")).cdId).toBeNull();
    const cd = await call(sessions.support, "POST", `/api/admin/staff/${iqbal.id}/cd-id`);
    expect(cd.statusCode).toBe(200);
    expect(cd.json().cdId).toEqual(expect.any(String));
    expect((await person("s.iqbal")).cdId).toEqual(expect.any(String));
  });

  it("lets support invite a desk, and refuses an auditor and security", async () => {
    const body = { ownerEmail: "invite-support@example.com", ownerName: "Invited Owner", businessName: "Invited FX" };
    await denied(await call(sessions.auditor, "POST", "/api/admin/onboarding/invite", { ...body, ownerEmail: "invite-auditor@example.com" }));
    expect(await byEmail("invite-auditor@example.com")).toBeUndefined();
    await denied(await call(sessions.security, "POST", "/api/admin/onboarding/invite", { ...body, ownerEmail: "invite-security@example.com" }));
    expect(await byEmail("invite-security@example.com")).toBeUndefined();
    const ok = await call(sessions.support, "POST", "/api/admin/onboarding/invite", body);
    expect(ok.statusCode).toBe(201);
    expect(await byEmail("invite-support@example.com")).toMatchObject({ status: "invited", kind: "early_access" });
  });

  it("lets support edit an application, and refuses an auditor and security", async () => {
    const notes = () => enquiry().then((row) => row.notes);
    await denied(await call(sessions.auditor, "PATCH", `/api/admin/enquiries/${ENQ}`, { notes: "auditor note" }));
    await denied(await call(sessions.security, "PATCH", `/api/admin/enquiries/${ENQ}`, { notes: "security note" }));
    expect(await notes()).toBeNull();
    expect((await call(sessions.support, "PATCH", `/api/admin/enquiries/${ENQ}`, { notes: "called them" })).statusCode).toBe(200);
    expect(await notes()).toBe("called them");

    await denied(await call(sessions.auditor, "PUT", `/api/admin/enquiries/${ENQ}/labels`, { labels: ["nope"] }));
    expect((await enquiry()).labels).toEqual([]);
    expect((await call(sessions.support, "PUT", `/api/admin/enquiries/${ENQ}/labels`, { labels: ["referred"] })).statusCode).toBe(200);
    expect((await enquiry()).labels).toEqual(["referred"]);

    const reference = (await enquiry()).reference;
    await denied(await call(sessions.auditor, "POST", `/api/admin/enquiries/${ENQ}/rotate`));
    expect((await enquiry()).reference).toBe(reference);
    const rotated = await call(sessions.support, "POST", `/api/admin/enquiries/${ENQ}/rotate`);
    expect(rotated.statusCode).toBe(200);
    expect((await enquiry()).reference).not.toBe(reference);
  });
});
