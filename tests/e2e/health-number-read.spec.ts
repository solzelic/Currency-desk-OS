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

test("LCTR and STR prefill leave the ID blank for a health-card-only client", async ({ page }) => {
  await signInAtDesk(page);
  await page.waitForFunction(() => (window as any).CDOS && (window as any).CDOS.LCTR && (window as any).CDOS.LCTR.buildMap);

  const filled = await page.evaluate(({ regime, secret }) => {
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
    const healthOnly = {
      idType: "OHIP",
      idNum: secret,
      province: "ON",
      country: "Canada",
      ids: [],
      documents: [{ docType: "Care Card", docNumber: secret }],
    };
    const withPassport = {
      idType: "Alberta Health",
      idNum: secret,
      province: "AB",
      country: "Canada",
      ids: [{ type: "Passport", num: "P8844221" }],
      documents: [],
    };
    const row = {
      ref: "TX-HEALTH",
      customer: "Health Only",
      date: "2026-10-01",
      time: "10:00",
      inCcy: "CAD",
      inAmt: 12000,
      outCcy: "USD",
      outAmt: 8000,
      type: "Exchange",
    };
    const read = (blocks: { instances?: { fields?: { id?: string; value?: string }[] }[] }[]) => {
      const fields: Record<string, string> = {};
      blocks.forEach((block) => {
        (block.instances || []).forEach((instance) => {
          (instance.fields || []).forEach((field) => {
            if (field && field.id) fields[field.id] = field.value || "";
          });
        });
      });
      return fields;
    };
    const build = (window as any).CDOS.LCTR.buildMap;
    const clients = { "Health Only": healthOnly, "Health Plus": withPassport };
    const str = read(build(
      { kind: "STR", subject: "Health Only", refs: [], reportRef: "R-STR", amount: 0 },
      { settings, clients, rows: [], regime },
    ));
    const lctr = read(build(
      { kind: "LCTR", subject: "Health Only", refs: ["TX-HEALTH"], reportRef: "R-LCTR", amount: 12000, basis: null },
      { settings, clients, rows: [row], regime },
    ));
    const accepted = read(build(
      { kind: "STR", subject: "Health Plus", refs: [], reportRef: "R-PASS", amount: 0 },
      { settings, clients, rows: [], regime },
    ));
    const dumped = JSON.stringify({ str, lctr, accepted });
    return {
      str: { type: str.su_idtype, num: str.su_idnum, jur: str.su_idjur },
      lctr: { type: lctr.cd_idtype, num: lctr.cd_idnum, jur: lctr.cd_idjur },
      accepted: { type: accepted.su_idtype, num: accepted.su_idnum },
      leaked: dumped.includes(secret),
    };
  }, { regime: REGIME, secret: SECRET });

  expect(filled.str).toEqual({ type: "", num: "", jur: "" });
  expect(filled.lctr).toEqual({ type: "", num: "", jur: "" });
  expect(filled.accepted).toEqual({ type: "Passport", num: "P8844221" });
  expect(filled.leaked).toBe(false);
});
