/* A health number that was already on the counter PC, and one that is
   still in the database, must not be on the screen or in this browser
   after the desk loads. An LCTR or STR must not prefill it either. */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, rendered } from "./fixtures";

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

  const created = await page.evaluate(async ({ name, secret }) => {
    const headers = { "content-type": "application/json" };
    const made = await fetch("/api/clients", {
      method: "POST",
      headers,
      body: JSON.stringify({ legalName: name, region: "ON" }),
    });
    const client = await made.json();
    if (!made.ok) return { status: made.status, body: client };
    const doc = await fetch(`/api/clients/${client.clientId}/documents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        docType: "OHIP",
        docNumber: secret,
        issuingJurisdiction: "ON",
        expiresOn: "2030-04-01",
        isPrimary: true,
      }),
    });
    return { status: doc.status, clientId: client.clientId, body: await doc.json() };
  }, { name: NAME, secret: SECRET });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(JSON.stringify(created.body)).not.toContain(SECRET);

  await page.evaluate(async ({ name, secret }) => {
    const cached = {
      [name]: {
        idType: "OHIP",
        idNum: secret,
        idExpiry: "2030-04-01",
        ids: [{ type: "Care Card", num: secret }],
      },
    };
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
  await card.click();
  await expect(page.getByText("OHIP").first()).toBeVisible();
  await expect(page.getByText("Issuing province").first()).toBeVisible();
  await expect(page.getByText("2030-04-01").first()).toBeVisible();
  await expect(page.getByText("Recorded").first()).toBeVisible();
  await expect(page.getByText(SECRET)).toHaveCount(0);
  const screen = await page.locator("body").innerText();
  expect(screen).not.toContain(SECRET);
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
