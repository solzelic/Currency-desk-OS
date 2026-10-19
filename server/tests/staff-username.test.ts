/* Usernames with the shop in them (amir.yorkfx), free on every desk, and the
   work email the invitation goes to. Full HTTP app against PGlite: York is
   the seeded desk; two more desks are written in directly so a username can
   be taken somewhere else, and so an older id can repeat across desks. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { nameParts, shopHandle } from "../src/auth/username.js";
import { firstSignInEmail } from "../src/routes/staff.js";

let handle: DbHandle;
let app: FastifyInstance;

const OWNER_PASSWORD = "harbour-owner-1";

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const login = async (staffId: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password } });

// the door the desk's sign-in screen uses — it never says which desk
const loginStart = async (staffId: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId, password } });

const suggest = async (cookies: Record<string, string>, query: string) =>
  app.inject({ method: "GET", url: `/api/staff/username?${query}`, cookies });

const create = async (cookies: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/staff", cookies, payload });

/* A second desk with its own owner, written in the way the platform
   bootstrap writes one. */
async function makeDesk(o: { id: string; name: string; slug: string | null; ownerId: string }) {
  const le = `le-${o.id}`;
  const br = `br-${o.id}`;
  await handle.db.insert(schema.tenants).values({ id: o.id, name: o.name, siteSlug: o.slug });
  await handle.db.insert(schema.legalEntities).values({ id: le, tenantId: o.id, name: o.name, homeCurrency: "CAD", jurisdictionPackId: "pack-ca-v1", jurisdictionPackVersion: 1 });
  await handle.db.insert(schema.branches).values({ id: br, tenantId: o.id, legalEntityId: le, name: "Main" });
  await handle.db.insert(schema.workspaces).values({ id: `ws-${o.id}`, tenantId: o.id, legalEntityId: le, branchId: br, tillId: "till-01" });
  await handle.db.insert(schema.staffUsers).values({
    id: `${o.id}:${o.ownerId}`, tenantId: o.id, legalEntityId: le, branchId: br, staffId: o.ownerId,
    name: "Owner", role: "administrator", authorizedBranchIds: [br],
    passwordHash: await hashPassword(OWNER_PASSWORD), mustChangePassword: false, passwordUpdatedAt: new Date(),
  });
  return { le, br };
}

let york: Record<string, string>;
let harbour: Record<string, string>;
let harbourDesk: { le: string; br: string };
let quayDesk: { le: string; br: string };
// Lina's temporary password, kept so a later test can sign in with the real one
let linaTemp = "";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  harbourDesk = await makeDesk({ id: "tnt-harbour", name: "Harbour FX", slug: "harbour-fx", ownerId: "owner.harbour" });
  quayDesk = await makeDesk({ id: "tnt-quay", name: "Quay Exchange", slug: null, ownerId: "owner.quay" });
  york = cookieOf(await login("r.haddad", DEMO.password));
  harbour = cookieOf(await login("owner.harbour", OWNER_PASSWORD));
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("the parts of a username", () => {
  it("is the first name and the shop handle, letters and digits only", () => {
    expect(nameParts("Amir Singh")).toEqual({ first: "amir", initial: "s" });
    expect(nameParts("  José  O'Neil ")).toEqual({ first: "jose", initial: "o" });
    expect(nameParts("Cher")).toEqual({ first: "cher", initial: "" });
    expect(nameParts("李明")).toEqual({ first: "staff", initial: "" });
    expect(shopHandle({ siteSlug: "harbour-fx", name: "Harbour FX" })).toBe("harbourfx");
    expect(shopHandle({ siteSlug: null, name: "Quay Exchange" })).toBe("quayexchange");
  });
});

describe("GET /api/staff/username", () => {
  it("is for a manager or the owner", async () => {
    expect((await app.inject({ method: "GET", url: "/api/staff/username?name=Amir" })).statusCode).toBe(401);
    const teller = cookieOf(await login("m.costa", DEMO.password));
    expect((await suggest(teller, "name=Amir")).statusCode).toBe(403);
  });

  it("suggests the first name and the shop", async () => {
    const res = await suggest(york, "name=Amir%20Singh");
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestion).toBe("amir.yorkfx");
    expect((await suggest(harbour, "name=Amir%20Singh")).json().suggestion).toBe("amir.harbourfx");
  });

  it("moves to the last initial, then a number, once a name is taken", async () => {
    expect((await create(york, { staffId: "amir.yorkfx", name: "Amir Singh", role: "teller" })).statusCode).toBe(201);
    expect((await suggest(york, "name=Amir%20Singh")).json().suggestion).toBe("amirs.yorkfx");
    expect((await create(york, { staffId: "amirs.yorkfx", name: "Amir Shah", role: "teller" })).statusCode).toBe(201);
    expect((await suggest(york, "name=Amir%20Sarkis")).json().suggestion).toBe("amir2.yorkfx");
  });

  it("says whether a typed username is free on every desk", async () => {
    const free = (await suggest(york, "check=nobody.yorkfx")).json().check;
    expect(free).toEqual({ staffId: "nobody.yorkfx", available: true, detail: null });
    const mine = (await suggest(harbour, "check=AMIR.YORKFX")).json().check;
    expect(mine.available).toBe(false);
    expect(mine.detail).toBe("Already taken on CurrencyDesk.");
    const shaped = (await suggest(york, "check=cd-york-0042")).json().check;
    expect(shaped.available).toBe(false);
    const bad = (await suggest(york, "check=has%20space")).json().check;
    expect(bad.available).toBe(false);
  });
});

describe("POST /api/staff — a username is free on every desk", () => {
  it("refuses a username another desk already has, and offers the next free one", async () => {
    const res = await create(harbour, { staffId: "Amir.YorkFX", name: "Amir Singh", role: "teller" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("staff_id_taken");
    expect(res.json().detail).toContain("Try amir.harbourfx");
  });

  it("refuses a username in the shape of a CurrencyDesk ID", async () => {
    const res = await create(york, { staffId: "CD-YORK-0042", name: "Shape Test", role: "teller" });
    expect(res.statusCode).toBe(400);
  });
});

describe("the work email and the first sign-in", () => {
  it("sends the invitation to the work email when the staff id is a username", async () => {
    const res = await create(harbour, { staffId: "lina.harbourfx", name: "Lina Haddad", role: "teller", email: "lina@harbour.example" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.staff.email).toBe("lina@harbour.example");
    expect(body.signIn.sentTo).toBe("lina@harbour.example");
    // no mail provider in tests, so the temporary password comes back to be passed on
    expect(body.signIn.delivered).toBe("simulated");
    expect(typeof body.signIn.tempPassword).toBe("string");
    linaTemp = body.signIn.tempPassword;

    /* The sign-in screen sends only the username and the password. Harbour
       is not the default desk, and the username still finds it. */
    const start = await loginStart("lina.harbourfx", body.signIn.tempPassword);
    expect(start.statusCode).toBe(200);
    expect(start.json().needsCode).toBe(false);
    expect(start.json().user.tenantId).toBe("tnt-harbour");
    expect(start.json().user.mustChangePassword).toBe(true);
  });

  it("with no work email, hands the temporary password back to be read out", async () => {
    const res = await create(harbour, { staffId: "omar.harbourfx", name: "Omar Ali", role: "teller" });
    expect(res.statusCode).toBe(201);
    expect(res.json().signIn.delivered).toBe("no_address");
    expect(res.json().signIn.sentTo).toBeNull();
    expect(res.json().signIn.detail).toContain("no work email on file");
  });

  it("a manager can set, change and clear the work email", async () => {
    const set = await app.inject({ method: "PATCH", url: "/api/staff/omar.harbourfx", cookies: harbour, payload: { email: "omar@harbour.example" } });
    expect(set.statusCode).toBe(200);
    expect(set.json().staff.email).toBe("omar@harbour.example");
    // the next invitation goes to it
    const invite = await app.inject({ method: "POST", url: "/api/staff/omar.harbourfx/invite", cookies: harbour });
    expect(invite.json().signIn.sentTo).toBe("omar@harbour.example");
    const cleared = await app.inject({ method: "PATCH", url: "/api/staff/omar.harbourfx", cookies: harbour, payload: { email: "" } });
    expect(cleared.json().staff.email).toBeNull();
    const bad = await app.inject({ method: "PATCH", url: "/api/staff/omar.harbourfx", cookies: harbour, payload: { email: "not-an-address" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("sign-in from the username alone", () => {
  it("an id that two desks both hold signs in nowhere", async () => {
    // older ids were only unique per desk, so this can exist; written in directly
    for (const [tenantId, desk] of [["tnt-harbour", harbourDesk], ["tnt-quay", quayDesk]] as const) {
      await handle.db.insert(schema.staffUsers).values({
        id: `${tenantId}:x.dup`, tenantId, legalEntityId: desk.le, branchId: desk.br, staffId: "x.dup",
        name: "Dup", role: "teller", authorizedBranchIds: [desk.br],
        passwordHash: await hashPassword("dup-pass-1"), mustChangePassword: false, passwordUpdatedAt: new Date(),
      });
    }
    expect((await loginStart("x.dup", "dup-pass-1")).statusCode).toBe(401);
  });

  it("a caller that names a desk gets that desk only", async () => {
    expect(linaTemp).not.toBe("");
    // her real password, at a desk that does not have her
    const named = await app.inject({
      method: "POST", url: "/api/auth/login/start",
      payload: { staffId: "lina.harbourfx", password: linaTemp, tenantId: DEMO.tenantId },
    });
    expect(named.statusCode).toBe(401);
    // the same password with no desk named finds her
    expect((await loginStart("lina.harbourfx", linaTemp)).statusCode).toBe(200);
  });

  it("York's older ids still sign in at York", async () => {
    const res = await loginStart("m.costa", DEMO.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.tenantId).toBe(DEMO.tenantId);
  });

  it("a manager cannot unlock somebody at another desk by their username", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login/unlock", cookies: york, payload: { staffId: "lina.harbourfx" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("the invitation email", () => {
  it("names the username, the temporary password and where to sign in", () => {
    const mail = firstSignInEmail({ name: "Lina Haddad", deskName: "Harbour FX", signInId: "lina.harbourfx", tempPassword: "quiet-harbour-71" });
    expect(mail.subject).toBe("Your sign-in for Harbour FX");
    expect(mail.text).toContain("Your username: lina.harbourfx");
    expect(mail.text).toContain("Temporary password: quiet-harbour-71");
    expect(mail.text).toContain("/login");
    expect(mail.html).toContain('href="');
  });

  it("does not run HTML typed into a name", () => {
    const mail = firstSignInEmail({ name: "<img src=x>", deskName: "A & B", signInId: "x.ab", tempPassword: "t" });
    expect(mail.html).not.toContain("<img src=x>");
    expect(mail.html).toContain("&lt;img src=x&gt;");
    expect(mail.html).toContain("A &amp; B");
  });
});
