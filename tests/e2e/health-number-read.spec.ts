/* A health number that was already on the counter PC, and one that is
   still in the database, must not be on the screen or in this browser
   after the desk loads. An LCTR or STR must not prefill it either.
   The names are the shared list. Each surface below runs that list. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, rendered } from "./fixtures";

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};
const { HEALTH_CARD_NAMES } = requireFromServer("../shared/health-card-names.js") as {
  HEALTH_CARD_NAMES: string[];
};

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no client records");

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const NAME = `Hana Health ${RUN}`;
const SECRET = `HN-9F3C-${RUN}-PRIV`;

const REGIME = {
  id: "FINTRAC",
  authority: "FINTRAC",
  country: "Canada",
  currency: "CAD",
  threshold: 10000,
  aggHours: 24,
  largeCode: "LCTR",
  largeLabel: "Large Cash Transaction Report",
  wireCode: "EFTR",
  wireLabel: "Electronic Funds Transfer Report",
  strCode: "STR",
  strLabel: "Suspicious Transaction Report",
};

async function openClients(page: Page) {
  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  await rendered(page, /New contact|contacts$/);
}

test("a loaded client file keeps no health number in the browser", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);

  const created = await page.evaluate(async ({ name }) => {
    const made = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: name, region: "ON" }),
    });
    const client = await made.json();
    return { status: made.status, clientId: client.clientId as string, body: client };
  }, { name: NAME });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const refused = await page.evaluate(async ({ clientId, secret }) => {
    const doc = await fetch(`/api/clients/${clientId}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "Ontario Health Insurance Plan",
        docNumber: secret,
        issuingJurisdiction: "ON",
        expiresOn: "2030-04-01",
        isPrimary: true,
      }),
    });
    return { status: doc.status, body: await doc.json() };
  }, { clientId: created.clientId, secret: SECRET });
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.body)).not.toContain(SECRET);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const owner = await pool.query(
    "SELECT tenant_id, legal_entity_id FROM desk_clients WHERE client_id=$1",
    [created.clientId],
  );
  await pool.query(
    `INSERT INTO desk_client_identity_documents
      (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number,
       issuing_jurisdiction, expires_on, is_primary, created_by)
     VALUES ($1,$2,$3,$4,'OHIP',$5,'ON','2030-04-01',true,'test')`,
    [`doc_e2e_${RUN}`, created.clientId, owner.rows[0]!.tenant_id, owner.rows[0]!.legal_entity_id, SECRET],
  );
  await pool.end();

  await page.evaluate(async ({ name, secret }) => {
    const cached = {
      [name]: {
        idType: "OHIP",
        idNum: secret,
        idExpiry: "2030-04-01",
        ids: [{ type: "Care Card", num: secret }],
      },
    };
    localStorage.setItem("cdos_tour_v1", JSON.stringify({
      "a.singh": { status: "finished", tour: "employee", at: Date.now() },
      "tnt-yorkfx:a.singh": { status: "finished", tour: "employee", at: Date.now() },
    }));
    localStorage.setItem("cdos_clients_v1", JSON.stringify(cached));
    localStorage.setItem("cdos_kyc_v1", JSON.stringify({
      checks: [{ idType: "RAMQ", idNum: secret }],
    }));
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("cdos-health-probe", 1);
      open.onerror = () => reject(open.error || new Error("Could not open the probe database"));
      open.onupgradeneeded = () => {
        open.result.createObjectStore("cache", { keyPath: "id" });
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("cache", "readwrite");
        tx.objectStore("cache").put({ id: "object", idType: "MSP", idNum: secret });
        tx.objectStore("cache").put({ id: "text", blob: JSON.stringify({ docType: "Alberta Health", docNumber: secret }) });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error || new Error("Could not plant a cached health number"));
      };
    });
  }, { name: NAME, secret: SECRET });

  await page.reload();
  await landOnDesktop(page);
  await page.waitForFunction(() => (window as any).CDOS && (window as any).CDOS.healthNumberScrubbed);
  const scrubError = await page.evaluate(async () => {
    try {
      await (window as any).CDOS.healthNumberScrubbed;
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(scrubError).toBe("");

  const stored = await page.evaluate(async (secret) => {
    const local: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) local.push(localStorage.getItem(key) || "");
    }
    const indexed: string[] = [];
    const databases = await indexedDB.databases();
    for (const info of databases) {
      if (!info.name) continue;
      const values = await new Promise<string>((resolve, reject) => {
        const open = indexedDB.open(info.name!);
        open.onerror = () => reject(open.error || new Error("Could not read " + info.name));
        open.onsuccess = () => {
          const db = open.result;
          const names = Array.from(db.objectStoreNames);
          if (!names.length) { db.close(); resolve(""); return; }
          const tx = db.transaction(names, "readonly");
          const found: unknown[] = [];
          let pending = names.length;
          names.forEach((storeName) => {
            const request = tx.objectStore(storeName).getAll();
            request.onerror = () => reject(request.error || new Error("Could not read " + storeName));
            request.onsuccess = () => {
              found.push(request.result);
              pending -= 1;
              if (pending === 0) { db.close(); resolve(JSON.stringify(found)); }
            };
          });
        };
      });
      indexed.push(values);
    }
    return { local: local.join("\n"), indexed: indexed.join("\n"), secret };
  }, SECRET);
  expect(stored.local).not.toContain(SECRET);
  expect(stored.indexed).not.toContain(SECRET);

  await openClients(page);
  const card = page.locator('div[role="button"]').filter({ hasText: NAME }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 });
  const search = page.getByPlaceholder("Search name, phone, or a file on their record…");
  await search.fill(SECRET);
  await expect(page.locator('div[role="button"]').filter({ hasText: NAME })).toHaveCount(0);
  await search.fill("");
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await card.click();
  await expect(page.getByText("OHIP").first()).toBeVisible();
  await expect(page.getByText("Issuing province").first()).toBeVisible();
  await expect(page.getByText("2030-04-01").first()).toBeVisible();
  await expect(page.getByText("Recorded").first()).toBeVisible();
  await expect(page.getByText(SECRET)).toHaveCount(0);
  const screen = await page.locator("body").innerText();
  expect(screen).not.toContain(SECRET);

  await page.getByRole("button", { name: "Edit" }).click();
  const options = await page.locator("select").evaluateAll((nodes) =>
    nodes.flatMap((node) => Array.from((node as HTMLSelectElement).options).map((option) => option.text)),
  );
  expect(options).toContain("Passport");
  expect(options).not.toContain("Health Card");
});

const NOTICE = "No accepted ID on file. Record a valid ID before filing if you can, otherwise file with what you have and note why.";

test("LCTR and STR prefill an accepted photo ID and do not block without one", async ({ page }) => {
  await signInAtDesk(page);
  await page.waitForFunction(() => (window as any).CDOS && (window as any).CDOS.LCTR && (window as any).CDOS.LCTR.buildMap);

  const filled = await page.evaluate(({ regime, secret, notice }) => {
    const settings = {
      timezone: "America/Toronto",
      structuringDays: 7,
      fintracContactName: "J. Masri",
      bizPhone: "",
      bizEmail: "",
      reportingEntityNumber: "8847213",
      activitySector: "Foreign exchange dealer",
      locationNumber: "00001",
      retentionYears: 5,
    };
    const row = (ref: string, customer: string, recordedId?: Record<string, string>) => ({
      ref,
      customer,
      date: "2026-10-01",
      time: "10:00",
      inCcy: "CAD",
      inAmt: 12000,
      outCcy: "USD",
      outAmt: 8000,
      type: "Exchange",
      recordedId: recordedId || null,
    });
    const read = (blocks: { instances?: { fields?: { id?: string; value?: string; notice?: string; blocksFiling?: boolean }[] }[] }[]) => {
      const fields: Record<string, { value: string; notice: string; blocksFiling: boolean }> = {};
      blocks.forEach((block) => {
        (block.instances || []).forEach((instance) => {
          (instance.fields || []).forEach((field) => {
            if (field && field.id) {
              fields[field.id] = {
                value: field.value || "",
                notice: field.notice || "",
                blocksFiling: field.blocksFiling !== false,
              };
            }
          });
        });
      });
      return fields;
    };
    const idOf = (fields: ReturnType<typeof read>, prefix: string) => ({
      type: fields[`${prefix}_idtype`]?.value || "",
      num: fields[`${prefix}_idnum`]?.value || "",
      jur: fields[`${prefix}_idjur`]?.value || "",
      notice: fields[`${prefix}_idtype`]?.notice || "",
      blocks: [fields[`${prefix}_idtype`], fields[`${prefix}_idnum`], fields[`${prefix}_idjur`]].some((field) => field && field.blocksFiling),
    });
    const build = (window as any).CDOS.LCTR.buildMap;
    const gate = (window as any).CDOS.LCTR.requiredFillKeys;
    const clients = {
      "Deal Recorded": {
        idType: "Passport",
        idNum: "P-CURRENT-FILE",
        idExpiry: "2030-04-01",
        province: "ON",
        country: "Canada",
      },
      "Fallback Licence": {
        idType: "OHIP",
        idNum: secret,
        idExpiry: "2030-04-01",
        province: "ON",
        country: "Canada",
        ids: [{ type: "Driver's Licence", num: "D445566", expiry: "2029-08-01", jurisdiction: "ON, Canada" }],
      },
      "Health Only": {
        idType: "OHIP",
        idNum: secret,
        idExpiry: "2030-04-01",
        province: "ON",
        country: "Canada",
        documents: [{ docType: "Care Card", docNumber: secret, expiresOn: "2030-04-01" }],
      },
      "Expired Only": {
        idType: "Passport",
        idNum: "P-EXPIRED-ONLY",
        idExpiry: "2020-01-01",
        province: "ON",
        country: "Canada",
      },
    };
    const recordedRow = row("TX-RECORDED", "Deal Recorded", {
      type: "Provincial ID",
      num: "PID-9001",
      expiry: "2031-01-01",
      jurisdiction: "BC, Canada",
    });
    const healthRow = row("TX-HEALTH", "Health Only");
    const expiredRow = row("TX-EXPIRED", "Expired Only");
    const fallbackRow = row("TX-FALLBACK", "Fallback Licence", {
      type: "Health Card",
      num: secret,
      expiry: "2030-04-01",
      jurisdiction: "ON",
    });
    const one = (kind: string, subject: string, refs: string[], rows: unknown[], reportRef: string) => build(
      { kind, subject, refs, reportRef, amount: 12000, basis: null },
      { settings, clients, rows, regime },
    );
    const recorded = one("LCTR", "Deal Recorded", ["TX-RECORDED"], [recordedRow], "R-REC");
    const recordedStr = one("STR", "Deal Recorded", ["TX-RECORDED"], [recordedRow], "R-REC-STR");
    const fallback = one("LCTR", "Fallback Licence", ["TX-FALLBACK"], [fallbackRow], "R-FALL");
    const health = one("LCTR", "Health Only", ["TX-HEALTH"], [healthRow], "R-HEALTH");
    const healthStr = one("STR", "Health Only", ["TX-HEALTH"], [healthRow], "R-HEALTH-STR");
    const expired = one("LCTR", "Expired Only", ["TX-EXPIRED"], [expiredRow], "R-EXP");
    const expiredStr = one("STR", "Expired Only", ["TX-EXPIRED"], [expiredRow], "R-EXP-STR");
    const blankGates = (blocks: unknown) => gate(blocks).filter((key: string) => /idtype|idnum|idjur/.test(key));
    return {
      recorded: idOf(read(recorded), "cd"),
      recordedStr: idOf(read(recordedStr), "su"),
      fallback: idOf(read(fallback), "cd"),
      health: idOf(read(health), "cd"),
      healthStr: idOf(read(healthStr), "su"),
      expired: idOf(read(expired), "cd"),
      expiredStr: idOf(read(expiredStr), "su"),
      healthGates: blankGates(health).concat(blankGates(healthStr)),
      expiredGates: blankGates(expired).concat(blankGates(expiredStr)),
      leaked: JSON.stringify({ recorded, recordedStr, fallback, health, healthStr, expired, expiredStr }).includes(secret),
      notice,
    };
  }, { regime: REGIME, secret: SECRET, notice: NOTICE });

  expect(filled.recorded).toMatchObject({ type: "Provincial ID", num: "PID-9001", jur: "BC, Canada", notice: "", blocks: true });
  expect(filled.recordedStr).toMatchObject({ type: "Provincial ID", num: "PID-9001", notice: "" });
  expect(filled.recorded.num).not.toBe("P-CURRENT-FILE");
  expect(filled.fallback).toMatchObject({ type: "Driver's Licence", num: "D445566", jur: "ON, Canada", notice: "" });
  expect(filled.health).toMatchObject({ type: "", num: "", jur: "", notice: NOTICE, blocks: false });
  expect(filled.healthStr).toMatchObject({ type: "", num: "", jur: "", notice: NOTICE, blocks: false });
  expect(filled.expired).toMatchObject({ type: "", num: "", jur: "", notice: NOTICE, blocks: false });
  expect(filled.expiredStr).toMatchObject({ type: "", num: "", jur: "", notice: NOTICE, blocks: false });
  expect(filled.healthGates).toEqual([]);
  expect(filled.expiredGates).toEqual([]);
  expect(filled.leaked).toBe(false);
});

test("the shared health-card list stays off search, the KYC cell, print, prefill, and localStorage", async ({ page }) => {
  await signInAtDesk(page);
  await page.waitForFunction(() =>
    (window as any).CDOS_HEALTH_CARDS
    && (window as any).CDOS.kycIdNumber
    && (window as any).CDOS.clientSearchText
    && (window as any).CDOS.exportClientReport
    && (window as any).CDOS.LCTR);

  const ran = await page.evaluate(({ names, secret }) => {
    const loaded = ((window as any).CDOS_HEALTH_CARDS.HEALTH_CARD_NAMES as string[]).join("\n");
    if (loaded !== names.join("\n")) return { error: "browser list is not the shared list", leaks: [loaded], surfaces: [], count: 0 };
    const leaks: string[] = [];
    const settings = { timezone: "America/Toronto", structuringDays: 7, retentionYears: 5 };
    const regime = {
      id: "FINTRAC", authority: "FINTRAC", country: "Canada", currency: "CAD",
      threshold: 10000, aggHours: 24, largeCode: "LCTR", largeLabel: "Large Cash Transaction Report",
      wireCode: "EFTR", wireLabel: "Electronic Funds Transfer Report", strCode: "STR", strLabel: "Suspicious Transaction Report",
    };
    names.forEach((name: string, index: number) => {
      const number = `${secret}-${index}`;
      localStorage.setItem(`cdos_probe_${index}`, JSON.stringify({
        idType: name, idNum: number, ids: [{ type: name, num: number }],
      }));
      const haystack = (window as any).CDOS.clientSearchText({
        idType: name, idNum: number, ids: [{ type: name, num: number }],
      });
      if (String(haystack).includes(number)) leaks.push(`search ${name}`);
      if ((window as any).CDOS.kycIdNumber({ idType: name, idNum: number })) leaks.push(`kyc-csv ${name}`);
      const opened: string[] = [];
      const origOpen = window.open;
      window.open = (() => ({
        document: { write: (html: string) => opened.push(html), close() {} },
        focus() {},
        print() {},
      })) as typeof window.open;
      try {
        (window as any).CDOS.exportClientReport(`Table ${index}`, {
          idType: name, idNum: number, idExpiry: "2030-04-01", kind: "individual",
        }, [], {}, settings);
      } finally {
        window.open = origOpen;
      }
      if (!opened.length || opened.join("").includes(number)) leaks.push(`print ${name}`);
      const blocks = (window as any).CDOS.LCTR.buildMap(
        { kind: "LCTR", subject: "Only", refs: ["TX"], reportRef: "R", amount: 12000, basis: null },
        {
          settings,
          regime,
          rows: [{ ref: "TX", customer: "Only", date: "2026-10-01", time: "10:00", inCcy: "CAD", inAmt: 12000, outCcy: "USD", outAmt: 8000, type: "Exchange" }],
          clients: { Only: { idType: name, idNum: number, idExpiry: "2030-04-01", province: "ON", country: "Canada" } },
        },
      );
      const str = (window as any).CDOS.LCTR.buildMap(
        { kind: "STR", subject: "Only", refs: ["TX"], reportRef: "S", amount: 12000, basis: null },
        {
          settings,
          regime,
          rows: [{ ref: "TX", customer: "Only", date: "2026-10-01", time: "10:00", inCcy: "CAD", inAmt: 12000, outCcy: "USD", outAmt: 8000, type: "Exchange" }],
          clients: { Only: { idType: name, idNum: number, idExpiry: "2030-04-01", province: "ON", country: "Canada" } },
        },
      );
      if (JSON.stringify(blocks).includes(number) || JSON.stringify(str).includes(number)) leaks.push(`prefill ${name}`);
    });
    (window as any).CDOS.scrubLocalHealthNumbers();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const raw = key ? (localStorage.getItem(key) || "") : "";
      if (raw.includes(secret)) leaks.push(`localStorage ${key}`);
    }
    return {
      error: "",
      leaks,
      surfaces: ["localStorage", "search", "kyc-csv", "print", "lctr-str-prefill"],
      count: names.length,
    };
  }, { names: HEALTH_CARD_NAMES, secret: "HN-SURFACE" });

  expect(ran.error).toBe("");
  expect(ran.leaks).toEqual([]);
  expect(ran.count).toBe(HEALTH_CARD_NAMES.length);
  expect(ran.surfaces).toEqual(["localStorage", "search", "kyc-csv", "print", "lctr-str-prefill"]);
});

test("a localStorage write failure does not blank the desk", async ({ page }) => {
  await signInAtDesk(page);
  const result = await page.evaluate(() => {
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
      return origErr.apply(console, args as []);
    };
    localStorage.setItem("cdos_desk_still_here", "open");
    localStorage.setItem("cdos_probe_ok", JSON.stringify({ idType: "OHIP", idNum: "HN-LOCAL-OK" }));
    localStorage.setItem("cdos_probe_fail", JSON.stringify({ idType: "Medicare card", idNum: "HN-LOCAL-FAIL" }));
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "cdos_probe_fail") throw new Error("quota");
      return orig.call(this, key, value);
    };
    try {
      (window as any).CDOS.scrubLocalHealthNumbers();
    } finally {
      Storage.prototype.setItem = orig;
      console.error = origErr;
    }
    return {
      logs: logs.join("\n"),
      still: localStorage.getItem("cdos_desk_still_here"),
      ok: localStorage.getItem("cdos_probe_ok"),
      fail: localStorage.getItem("cdos_probe_fail"),
      length: localStorage.length,
    };
  });
  expect(result.still).toBe("open");
  expect(result.ok || "").not.toContain("HN-LOCAL-OK");
  expect(result.fail || "").toContain("HN-LOCAL-FAIL");
  expect(result.logs).toContain("could not clear a cached health number");
  expect(result.length).toBeGreaterThan(2);
});

test("an IndexedDB clear that does not finish is logged and does not hang", async ({ page }) => {
  await signInAtDesk(page);
  const result = await page.evaluate(async () => {
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
      return origErr.apply(console, args as []);
    };
    const orig = indexedDB.databases.bind(indexedDB);
    indexedDB.databases = () => new Promise(() => {}) as Promise<IDBDatabaseInfo[]>;
    const started = Date.now();
    await (window as any).CDOS.scrubIndexedHealthNumbers();
    indexedDB.databases = orig;
    console.error = origErr;
    return { ms: Date.now() - started, logs: logs.join("\n") };
  });
  expect(result.ms).toBeGreaterThan(3000);
  expect(result.ms).toBeLessThan(7000);
  expect(result.logs).toContain("timed out clearing a cached health number");
});

test("the KYC CSV that opens has no health number", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  const name = `Kyc Csv ${RUN}`;
  const secret = `HN-CSV-${RUN}-PRIV`;
  const created = await page.evaluate(async (legalName) => {
    const made = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName, region: "ON" }),
    });
    const body = await made.json();
    return { status: made.status, clientId: body.clientId as string };
  }, name);
  expect(created.status).toBe(201);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const owner = await pool.query(
    "SELECT tenant_id, legal_entity_id FROM desk_clients WHERE client_id=$1",
    [created.clientId],
  );
  await pool.query(
    `INSERT INTO desk_client_identity_documents
      (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number,
       issuing_jurisdiction, expires_on, is_primary, created_by)
     VALUES ($1,$2,$3,$4,'OHIP',$5,'ON','2030-04-01',true,'test')`,
    [`doc_csv_${RUN}`, created.clientId, owner.rows[0]!.tenant_id, owner.rows[0]!.legal_entity_id, secret],
  );
  await pool.end();
  await page.evaluate(() => {
    const done = { status: "finished", tour: "employee", at: Date.now() };
    localStorage.setItem("cdos_tour_v1", JSON.stringify({ "j.masri": done, "tnt-yorkfx:j.masri": done }));
  });
  await page.reload();
  await landOnDesktop(page);
  await page.getByText(/^Reports$/).first().click();
  await rendered(page, /End-of-Day Sign-Off/);
  await page.getByText("Client & KYC Register").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
  const sheet = await page.locator("#cdos-report-doc").innerText();
  expect(sheet).toContain(name);
  expect(sheet).toContain("OHIP");
  expect(sheet).not.toContain(secret);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "CSV" }).click(),
  ]);
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv).toContain(name);
  expect(csv).toContain("OHIP");
  expect(csv).not.toContain(secret);
});
