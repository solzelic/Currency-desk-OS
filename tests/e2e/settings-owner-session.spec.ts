/* A teller and a manager each work a real desk, not the York FX demo.

   York never autosaves. These two do. Sign-in used to rewrite the role
   presets and the billing plan, the server answered 403, and the bridge
   then stopped saving for the rest of the session. A customer and the
   day state have to land, with no refusal and no refusal audit row.
   A deliberate change to the large-cash line still refuses, shows that,
   reloads the stored desk, and keeps saving.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect, hasLedger, landOnDesktop, rendered, codeFor, logSize } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the desk under test autosaves to Postgres");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { n: string }[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@owner-session.example`;
const SHOP = `Owner Session ${stamp}`;
const SLUG = `osess${stamp}`;
const TELLER = `teller${stamp}`;
const MANAGER = `mgr${stamp}`;
const TEMP = "counter-pass-2026";
const NEXT = "counter-next-2026";

let pool: InstanceType<typeof Pool>;
let tenantId = "";

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function refusalCount(): Promise<number> {
  const rows = await pool.query(
    "SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1 AND action='settings.owner_only_refused'",
    [tenantId],
  );
  return Number(rows.rows[0]?.n ?? 0);
}

function watchSaves(page: Page): number[] {
  const codes: number[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/api/tenant/state") && res.request().method() === "PUT") codes.push(res.status());
  });
  return codes;
}

async function signIn(page: Page, staffId: string, password: string, name: string, role: string): Promise<void> {
  /* Detach the bridge before the cookie changes. A reload flushes the
     open page, and that flush would otherwise go out as the next person.
     The directory entry has to be in localStorage before the reload:
     the shell picks the role from that list on the first paint, and a
     later restore of the saved desk does not change who is signed in. */
  await page.evaluate(async ({ staffId, name, role }) => {
    const bridge = (window as unknown as { CDOS_PERSIST?: { end: () => Promise<void> } }).CDOS_PERSIST;
    if (bridge) await bridge.end();
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}") as { employees?: Record<string, unknown>[] };
    const stations = JSON.parse(localStorage.getItem("cdos_stations_v2") || "[]") as { id?: string }[];
    const branchId = stations[0]?.id || "b01";
    const employees = Array.isArray(raw.employees) ? raw.employees : [];
    const row = employees.find((e) => e.code === staffId);
    if (row) {
      row.name = name;
      row.role = role;
      row.branches = [branchId];
      row.home = branchId;
      row.active = true;
    } else {
      employees.push({
        id: "e_" + staffId, code: staffId, name, role, active: true,
        requirePin: false, branches: [branchId], home: branchId,
      });
    }
    raw.employees = employees;
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  }, { staffId, name, role });
  const status = await page.evaluate(async ({ staffId, password, tenantId }) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ staffId, password, tenantId }),
    });
    return r.status;
  }, { staffId, password, tenantId });
  if (status !== 200) throw new Error(`sign-in failed for ${staffId}: ${status}`);
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
}

async function addContact(page: Page, name: string): Promise<void> {
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
  await page.getByRole("button", { name: /^New contact$/ }).click();
  const skipId = page.getByText(/^Skip — add ID later$/);
  if (await skipId.isVisible({ timeout: 5_000 }).catch(() => false)) await skipId.click();
  await page.getByPlaceholder("Jane Doe").fill(name);
  await page.getByText(/^Save without verifying$/).click();
  const profile = page.locator("div.fixed.inset-0").filter({ hasText: name }).first();
  await profile.waitFor({ state: "visible", timeout: 20_000 });
  /* The profile covers the desk. A click outside it is how it closes. */
  await profile.click({ position: { x: 6, y: 6 } });
  await profile.waitFor({ state: "hidden", timeout: 10_000 });
}

async function savedState(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const r = await fetch("/api/tenant/state", { credentials: "same-origin" });
    const body = await r.json();
    return (body.state ?? {}) as Record<string, string>;
  });
}

async function shots(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const size of [
    { width: 390, height: 844 },
    { width: 360, height: 780 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${size.width}.png`) });
  }
}

test("a teller and a manager save a customer and the day, and a threshold change is refused without stopping", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const saves = watchSaves(page);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-os${stamp}`, `CD-O${String(stamp).slice(-6)}`, EMAIL, "Session Owner"],
  );
  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Session Owner",
      email: EMAIL,
      password: "owner-session-2026",
      slug: SLUG,
      onboarding: { country: "Canada", homeCurrency: "CAD", city: "Toronto", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);
  tenantId = (await verified.json()).tenant.id as string;

  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const hired = await page.evaluate(async ({ teller, manager, password }) => {
    const post = (role: string, staffId: string, name: string) =>
      fetch("/api/staff", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId, name, role, password }),
      }).then(async (r) => ({ status: r.status, body: await r.text() }));
    return {
      teller: await post("teller", teller, "Session Teller"),
      manager: await post("branch_manager", manager, "Session Manager"),
    };
  }, { teller: TELLER, manager: MANAGER, password: TEMP });
  expect(hired.teller.status, hired.teller.body).toBe(201);
  expect(hired.manager.status, hired.manager.body).toBe(201);

  /* API-created staff are not in the desk's employee list, so the shell
     treats them as unassigned and never opens the desktop. Post both to
     this branch the way Branch Network would, and save that before anyone
     else signs in. */
  const posted = await page.evaluate(async ({ teller, manager }) => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}") as { employees?: Record<string, unknown>[] };
    const stations = JSON.parse(localStorage.getItem("cdos_stations_v2") || "[]") as { id?: string }[];
    const branchId = stations[0]?.id || "b01";
    const employees = Array.isArray(raw.employees) ? raw.employees : [];
    const add = (code: string, name: string, role: string) => {
      if (employees.some((e) => e.code === code)) return;
      employees.push({
        id: "e_" + code, code, name, role, email: "", phone: "", active: true,
        requirePin: false, caps: null, apps: null, branches: [branchId], home: branchId,
      });
    };
    add(teller, "Session Teller", "Cashier");
    add(manager, "Session Manager", "Manager");
    raw.employees = employees;
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    const bridge = (window as unknown as { CDOS_PERSIST: { save: () => Promise<void> } }).CDOS_PERSIST;
    await bridge.save();
    const back = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json());
    return JSON.stringify(back.state?.cdos_settings ?? "");
  }, { teller: TELLER, manager: MANAGER });
  expect(posted).toContain(TELLER);
  expect(posted).toContain(MANAGER);
  await page.reload();
  await landOnDesktop(page);
  await page.evaluate(async () => {
    const bridge = (window as unknown as { CDOS_PERSIST: { end: () => Promise<void> } }).CDOS_PERSIST;
    await bridge.end();
  });

  for (const staffId of [TELLER, MANAGER]) {
    await page.evaluate(async ({ staffId, tenantId, temp, next }) => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      const signed = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId, password: temp, tenantId }),
      });
      if (!signed.ok) throw new Error("login " + signed.status);
      const changed = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: temp, newPassword: next }),
      });
      if (!changed.ok) throw new Error("password " + changed.status);
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    }, { staffId, tenantId, temp: TEMP, next: NEXT });
  }

  const beforeTeller = saves.length;
  await signIn(page, TELLER, NEXT, "Session Teller", "Cashier");
  await addContact(page, `Ada ${stamp}`);
  await expect.poll(async () => JSON.stringify(await savedState(page)), { timeout: 20_000 }).toContain(`Ada ${stamp}`);
  const tellerSaves = saves.slice(beforeTeller);
  expect(tellerSaves).toContain(200);
  expect(tellerSaves).not.toContain(403);
  const tellerState = await savedState(page);
  expect(tellerState.cdos_day).toBeTruthy();
  expect(await refusalCount()).toBe(0);
  await shots(page, testInfo, "normal-save");

  const banner = await page.evaluate(async () => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.threshold = 999999;
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    const bridge = (window as unknown as { CDOS_PERSIST: { save: () => Promise<void> } }).CDOS_PERSIST;
    await bridge.save();
    return document.getElementById("cdos-persist-banner")?.textContent ?? "";
  });
  expect(banner).toMatch(/Only the owner can change that setting/);
  await shots(page, testInfo, "refusal");
  expect(await refusalCount()).toBe(1);

  /* A Rates save that the server still refuses must not toast, and the
     stored spread stays. The panel keeps what was typed on its own. */
  const held = await page.evaluate(async () => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}") as { defaultSpread?: number };
    const stored = raw.defaultSpread;
    raw.defaultSpread = 9.5;
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    const bridge = (window as unknown as { CDOS_PERSIST: { save: (opts: { keepTyped: boolean }) => Promise<string | void> } }).CDOS_PERSIST;
    const result = await bridge.save({ keepTyped: true });
    const back = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json()) as { state: { cdos_settings: string } };
    const settings = JSON.parse(back.state.cdos_settings) as { defaultSpread?: number };
    return { result, toast: document.getElementById("cdos-persist-banner")?.textContent ?? "", spread: settings.defaultSpread, stored };
  });
  expect(held.result).toBe("refused");
  expect(held.toast).toBe("");
  expect(held.spread).toBe(held.stored);
  expect(await refusalCount()).toBe(2);

  const kept = await page.evaluate(async () => {
    const day = JSON.parse(localStorage.getItem("cdos_day") || "{}");
    day.note = "still-saving";
    localStorage.setItem("cdos_day", JSON.stringify(day));
    const bridge = (window as unknown as { CDOS_PERSIST: { save: () => Promise<void> } }).CDOS_PERSIST;
    await bridge.save();
    const back = await fetch("/api/tenant/state", { credentials: "same-origin" }).then((r) => r.json());
    const settings = JSON.parse(back.state.cdos_settings);
    const savedDay = JSON.parse(back.state.cdos_day);
    return { threshold: settings.threshold, note: savedDay.note, status: "ok" };
  });
  expect(kept.threshold).not.toBe(999999);
  expect(kept.note).toBe("still-saving");

  const beforeManager = saves.length;
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }));
  await signIn(page, MANAGER, NEXT, "Session Manager", "Manager");
  await page.setViewportSize({ width: 1280, height: 800 });
  await addContact(page, `Bea ${stamp}`);
  await expect.poll(async () => JSON.stringify(await savedState(page)), { timeout: 20_000 }).toContain(`Bea ${stamp}`);
  const managerSaves = saves.slice(beforeManager);
  expect(managerSaves).toContain(200);
  expect(managerSaves).not.toContain(403);
  expect((await savedState(page)).cdos_day).toBeTruthy();
  expect(await refusalCount()).toBe(2);
});
