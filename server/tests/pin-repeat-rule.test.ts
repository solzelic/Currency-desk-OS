/* Sol, 3 Nov 2026: a new or changed PIN made of one digit repeated is
   refused everywhere, with its own words. Runs and years keep the old rule
   and the old words. The staging 0000 path from #609 is gone: the server
   checks the stored hash and nothing else, on every runtime. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { createSession } from "../src/auth/sessions.js";
import { clearPinAttempts, weakPinDetail } from "../src/routes/pin.js";

const here = dirname(fileURLToPath(import.meta.url));
/* A no-break space keeps "1111." from wrapping onto a line alone. */
const REPEAT = "Pick a PIN that isn't one digit repeated, like\u00a01111.";
const EASY = "That PIN is too easy to guess. Pick a different PIN.";
const REPEATS = Array.from({ length: 10 }, (_, d) => String(d).repeat(4));
const STAGING_HOST = "currencydesk-staging.onrender.com";
/* What #609 used to read. Set here to prove nothing reads it now. */
const OLD_STAGING_ENV = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: STAGING_HOST, STAGING_DEFAULT_PIN: "1" };

describe("the words", () => {
  it("a repeat has its own message; runs and years keep theirs; 1100 and 0001 pass", () => {
    for (const pin of REPEATS) expect(weakPinDetail(pin), pin).toBe(REPEAT);
    for (const pin of ["1234", "9876", "1999", "2024"]) expect(weakPinDetail(pin), pin).toBe(EASY);
    for (const pin of ["1100", "0001", "1122", "4826"]) expect(weakPinDetail(pin), pin).toBeNull();
  });
});

describe("the PIN routes", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  const saved: Record<string, string | undefined> = {};
  const row = (staffId: string) =>
    handle.db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.staffId, staffId), eq(schema.staffUsers.tenantId, "tnt-yorkfx"))).limit(1).then((r) => r[0]!);
  /* No till on the session, so a switch does not reach ledger tables this
     embedded database does not have. */
  const as = async (staffId: string) => ({ cdos_session: (await createSession(handle.db, (await row(staffId)).id, { workspaceId: null })).token });
  const post = (cookies: Record<string, string>, url: string, payload: object, host = "127.0.0.1") =>
    app.inject({ method: "POST", url, cookies, payload, headers: { host } });

  beforeAll(async () => {
    for (const k of ["PGLITE_MEMORY", "SEED_PASSWORD", ...Object.keys(OLD_STAGING_ENV)]) saved[k] = process.env[k];
    Object.assign(process.env, { PGLITE_MEMORY: "1", SEED_PASSWORD: "yorkville" }, OLD_STAGING_ENV);
    vi.spyOn(console, "log").mockImplementation(() => {});
    handle = await createDb();
    await seed(handle.db);
    await handle.db.update(schema.tenants).set({ isTestShop: true }).where(eq(schema.tenants.id, "tnt-yorkfx"));
    app = await buildApp(handle.db);
  });
  afterAll(async () => {
    await app.close(); await handle.close(); vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  beforeEach(async () => {
    await handle.db.update(schema.staffUsers).set({ pinHash: null, pinMustChange: false }).where(eq(schema.staffUsers.tenantId, "tnt-yorkfx"));
    for (const id of ["a.singh", "m.costa", "j.masri"]) clearPinAttempts((await row(id)).id);
  });

  it("refuses all ten repeats on set, change, a manager's set and reset, on a live and a staging Host", async () => {
    for (const host of ["www.currencydeskos.com", STAGING_HOST]) {
      const singh = await as("a.singh");
      for (const pin of REPEATS) {
        const set = await post(singh, "/api/staff/pin", { pin }, host);
        expect([set.statusCode, set.json().detail], `set ${pin} ${host}`).toEqual([422, REPEAT]);
        const issued = await post(await as("j.masri"), "/api/staff/pin", { staffId: "m.costa", pin }, host);
        expect([issued.statusCode, issued.json().detail], `issue ${pin} ${host}`).toEqual([422, REPEAT]);
        const reset = await post(singh, "/api/staff/pin/reset", { password: "yorkville", pin }, host);
        expect([reset.statusCode, reset.json().detail], `reset ${pin} ${host}`).toEqual([422, REPEAT]);
      }
      expect((await post(singh, "/api/staff/pin", { pin: "1100" }, host)).statusCode).toBe(200);
      for (const pin of REPEATS) {
        const change = await post(singh, "/api/staff/pin", { pin, currentPin: "1100" }, host);
        expect([change.statusCode, change.json().detail], `change ${pin} ${host}`).toEqual([422, REPEAT]);
      }
      expect((await post(singh, "/api/staff/pin", { pin: "0001", currentPin: "1100" }, host)).statusCode).toBe(200);
      await handle.db.update(schema.staffUsers).set({ pinHash: null }).where(eq(schema.staffUsers.tenantId, "tnt-yorkfx"));
      clearPinAttempts((await row("a.singh")).id);
    }
  });

  it("has no 0000 path any more: no PIN is 409, a set PIN refuses 0000, and GET writes nothing", async () => {
    const singh = await as("a.singh");
    const verify = await post(singh, "/api/staff/pin/verify", { pin: "0000" }, STAGING_HOST);
    expect([verify.statusCode, verify.json().error]).toEqual([409, "no_pin"]);
    const other = await post(singh, "/api/staff/pin/verify", { staffId: "m.costa", pin: "0000" }, STAGING_HOST);
    expect([other.statusCode, other.json().error]).toEqual([409, "no_pin"]);
    const sw = await post(singh, "/api/auth/switch", { staffId: "m.costa", pin: "0000" }, STAGING_HOST);
    expect([sw.statusCode, sw.json().error]).toEqual([409, "no_pin"]);
    const audits = async () => (await handle.db.select().from(schema.auditEvents)).length;
    const before = await audits();
    const got = await app.inject({ method: "GET", url: "/api/staff/pin", cookies: singh, headers: { host: STAGING_HOST } });
    expect(got.json().hasPin).toBe(false);
    expect(Object.keys(got.json()).sort()).toEqual(["hasPin", "mustChange", "setAt"]);
    expect(await audits()).toBe(before);
    expect((await post(singh, "/api/staff/pin", { pin: "4826" }, STAGING_HOST)).statusCode).toBe(200);
    expect((await post(singh, "/api/staff/pin/verify", { pin: "0000" }, STAGING_HOST)).statusCode).toBe(401);
    expect((await post(singh, "/api/staff/pin/verify", { pin: "4826" }, STAGING_HOST)).statusCode).toBe(200);
  });
});

/* Every PIN hash the server writes is either a PIN that passed the rule or
   one generatePin made (which never makes a weak one). */
describe("PIN writers", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  it("all go through the rule or generatePin", () => {
    const root = join(here, "../src");
    const writes = files(root).flatMap((p) => {
      const text = readFileSync(p, "utf8");
      return [...text.matchAll(/pinHash:\s*([^,}]+)/g)].map((m) => [p.slice(root.length + 1), m[1]!.trim()] as const);
    }).filter(([, value]) => !value.startsWith("text(\"pin_hash\")"));
    expect(writes).toEqual([
      ["routes/admin.ts", "await hashPin(pin)"],
      ["routes/pin.ts", "await hashPin(parsed.data.pin)"],
      ["routes/pin.ts", "await hashPin(parsed.data.pin)"],
      ["routes/pin.ts", "await hashPin(parsed.data.pin)"],
      ["routes/staff.ts", "await hashPin(pin)"],
    ]);
    const pin = readFileSync(join(root, "routes/pin.ts"), "utf8");
    expect(pin.match(/weakPinDetail\(parsed\.data\.pin\)/g)).toHaveLength(3);
    for (const f of ["routes/admin.ts", "routes/staff.ts"]) expect(readFileSync(join(root, f), "utf8")).toMatch(/const pin = generatePin\(\);/);
    expect(files(root).some((p) => p.endsWith("staging-default-pin.ts"))).toBe(false);
  });

  /* #609 PR B: the staging reset is the one writer that skips the rule, by
     name. A raw SQL PIN write anywhere else fails here. */
  it("allows exactly one raw PIN write: writeStagingResetPin in staging/pin-reset.ts", () => {
    const root = join(here, "../src");
    const raw = files(root).filter((p) => /pin_hash\s*=\s*\$/i.test(readFileSync(p, "utf8"))).map((p) => p.slice(root.length + 1));
    expect(raw).toEqual(["staging/pin-reset.ts"]);
    const text = readFileSync(join(root, "staging/pin-reset.ts"), "utf8");
    expect(text.match(/pin_hash\s*=\s*\$/gi)).toHaveLength(1);
    const body = text.slice(text.indexOf("async function writeStagingResetPin("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/pin_hash\s*=\s*\$/i);
  });

  it("only the CLI inserts into db_environment, no route names it, and only the reset writes seeded_by", () => {
    const root = join(here, "../src");
    const all = files(root).filter((p) => !p.includes("/db/migrations/"));
    const named = (re: RegExp) => all.filter((p) => re.test(readFileSync(p, "utf8"))).map((p) => p.slice(root.length + 1));
    expect(named(/insert\s+into\s+db_environment/i)).toEqual(["staging/cli.ts"]);
    expect(named(/db_environment/).filter((p) => p.startsWith("routes/") || p === "app.ts")).toEqual([]);
    expect(named(/seeded_by\s*=/i)).toEqual(["staging/pin-reset.ts"]);
    /* is_test_shop: provisioning from the two staging fresh-shop doors, the reset marking the seed shop,
       and markTestShop in seed.ts, which only a test harness calls (CD-111: a test shop keeps Transfers). */
    expect(named(/isTestShop\s*:(?!\s*schema\.tenants\.isTestShop)|isTestShop\s*=(?!=)|is_test_shop\s*=\s*true/)).toEqual(
      ["db/schema.ts", "onboarding/provision.ts", "routes/onboarding-public.ts", "routes/signup.ts", "seed.ts", "staging/pin-reset.ts"]);
  });
});

/* The browser never compares a PIN, and shows the server's reason. */
describe("the desk bundle", () => {
  it("holds no 0000 PIN and no staging default", () => {
    const bundle = readFileSync(join(here, "../../web/app/os.js"), "utf8");
    expect(bundle).not.toMatch(/(?:pin|Pin|PIN|expected|exp)["']?\s*[:=]\s*(?:[^,;)\n]{0,40}\?\s*)?["']0000["']/);
    expect(bundle).not.toMatch(/===\s*["']0000["']|["']0000["']\s*===/);
    expect(bundle).not.toContain("defaultPin");
    expect(bundle).not.toContain("Staging PIN 0000");
    for (const words of ["Too many wrong tries. Wait a few minutes.", "No connection. The PIN was not changed.", "Records are permanent. A posted transaction"]) {
      expect(bundle, words).toContain(words);
    }
    expect(bundle).not.toMatch(/Too many wrong tries \u2014|No connection \u2014|Records are permanent \u2014/);
  });
});
