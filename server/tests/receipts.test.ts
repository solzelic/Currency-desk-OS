import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Decimal from "decimal.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { RECEIPT_CLOSING } from "../src/receipts/closing.js";
import { receiptText, receiptView } from "../src/receipts/document.js";
import { receiptPdf } from "../src/receipts/pdf.js";
import { RECEIPT_DEFAULTS, type ReceiptIdentity, type ReceiptOptions } from "../src/receipts/settings.js";

let handle: DbHandle;
let app: FastifyInstance;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

async function login(staffId: string): Promise<Record<string, string>> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  expect(res.statusCode).toBe(200);
  const cookies = sessionCookie(res);
  if (!cookies.cdos_session) throw new Error("no session");
  return { cdos_session: cookies.cdos_session };
}

const identity: ReceiptIdentity = {
  shopName: "York Currency Exchange Inc.",
  address: null,
  phone: null,
  licence: "M12345678",
  cdId: null,
  rateUrl: null,
  timezone: "America/Toronto",
  language: { code: "en", label: "English" },
  shopEmail: null,
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("receipt settings", () => {
  it("previews the existing closing line and says email is not configured", async () => {
    const cookies = await login("j.masri");
    const res = await app.inject({ method: "GET", url: "/api/desk/receipt-settings", cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.closing).toBe(RECEIPT_CLOSING);
    expect(body.closing).toBe("Thank you \u2014 keep for your records");
    expect(body.emailConfigured).toBe(false);
    expect(body.options).toMatchObject({ paper: "80mm", showRate: true, showFees: true, autoPrint: false });
    expect(body.identity.shopName).toBe("York Currency Exchange Inc.");
    expect(body.identity.licence).toBe("M12345678");
    expect(body.identity.cdId).toBeNull();
    expect(body.identity.language).toEqual({ code: "en", label: "English" });
    expect(body.printerHelp).toContain("TCP 9100");
  });

  it("keeps one desk's options off another desk", async () => {
    const cookies = await login("j.masri");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/desk/receipt-settings",
      cookies,
      payload: { paper: "58mm", header: "York till", showRate: false },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().options).toMatchObject({ paper: "58mm", header: "York till", showRate: false });
    expect(saved.json().closing).toBe(RECEIPT_CLOSING);

    await handle.db.insert(schema.tenants).values({ id: "tnt-otherdesk", name: "Other Desk" }).onConflictDoNothing();
    await handle.db.update(schema.tenants).set({
      receiptSettings: { ...RECEIPT_DEFAULTS, paper: "letter", header: "Other shop" },
    }).where(eq(schema.tenants.id, "tnt-otherdesk"));

    const again = await app.inject({ method: "GET", url: "/api/desk/receipt-settings", cookies });
    expect(again.json().options.header).toBe("York till");
    expect(again.json().options.paper).toBe("58mm");
    const stored = await handle.db.select({ receiptSettings: schema.tenants.receiptSettings })
      .from(schema.tenants).where(eq(schema.tenants.id, DEMO.tenantId));
    expect(stored[0]?.receiptSettings).toMatchObject({ paper: "58mm", header: "York till" });
  });

  it("lets only the owner change receipt setup", async () => {
    for (const staffId of ["a.singh", "r.haddad", "m.costa"]) {
      const cookies = await login(staffId);
      const denied = await app.inject({
        method: "PUT",
        url: "/api/desk/receipt-settings",
        cookies,
        payload: { paper: "a4" },
      });
      expect(denied.statusCode).toBe(403);
      const readable = await app.inject({ method: "GET", url: "/api/desk/receipt-settings", cookies });
      expect(readable.statusCode).toBe(200);
    }
  });

  it("refuses a logo that is not an image", async () => {
    const cookies = await login("j.masri");
    const res = await app.inject({
      method: "PUT",
      url: "/api/desk/receipt-settings",
      cookies,
      payload: { logo: "data:text/plain;base64,aGVsbG8=" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("receipt document", () => {
  it("prints ledger amount strings and the existing closing line", () => {
    const options: ReceiptOptions = { ...RECEIPT_DEFAULTS, footer: "" };
    const view = receiptView({
      transactionRef: "CD-260101-000001",
      postedAt: "2026-01-01T15:00:00.000Z",
      postedAtLocal: "2026-01-01, 10:00",
      customerName: "Demo Customer",
      fromCurrency: "CAD",
      toCurrency: "JPY",
      inputAmount: "1000.00",
      outputAmount: "109900.00",
      rate: "109.900000000000",
      feeCad: "4.00",
    }, options, identity, null);
    expect(view.closing).toBe(RECEIPT_CLOSING);
    expect(view.paid).toBe("1000.00 CAD");
    expect(new Decimal(view.paid!.split(" ")[0]!).eq("1000.00")).toBe(true);
    expect(new Decimal(view.rate!).eq("109.900000000000")).toBe(true);
    expect(view.received).toBe("109900.00 JPY");
    expect(view.cdIdLine).toBe("No CurrencyDesk ID issued yet");
    const hidden = receiptView({
      transactionRef: "CD-260101-000001",
      postedAt: "2026-01-01T15:00:00.000Z",
      customerName: "Demo Customer",
      fromCurrency: "CAD",
      toCurrency: "USD",
      inputAmount: "10.00",
      outputAmount: "7.00",
      rate: "0.70",
      feeCad: "1.00",
    }, { ...options, showRate: false, showFees: false, showClientName: false }, identity, null);
    expect(hidden.rate).toBeNull();
    expect(hidden.fee).toBeNull();
    expect(hidden.clientName).toBeNull();
    expect(hidden.paid).toBe("10.00 CAD");
    const pdf = receiptPdf(receiptText(view));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("1000.00 CAD");
    expect(pdf.toString("latin1")).toContain("Thank you");
  });
});
