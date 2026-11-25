/* The desk says which provider is in use, and why a check stopped.
   Customer consent never shows a bracket placeholder. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONSENT_VERSION, CONSENT_VERSION_PREVIOUS, DIDIT_CONSENT_VERSION, DIDIT_CONSENT_VERSION_PREVIOUS,
  consentCopy, diditNoticeCopy, diditSelfieConsentCopy, noticeCopy, privacyReady, selfieConsentCopy,
  type ConsentFill,
} from "../src/idv/consent-copy.js";
import { idvReadyReason } from "../src/idv/ready.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const React = require("react");
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

const STAGING = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" };
const empty: ConsentFill = {
  legalName: null, privacyContact: null, privacyEmail: null, privacyPhone: null,
  privacyPolicyUrl: null, personaNoticeUrl: null, faceCrop: false,
};
const filled: ConsentFill = {
  legalName: "York Currency Exchange Inc.", privacyContact: "Privacy", privacyEmail: "p@example.com",
  privacyPhone: "4165550100", privacyPolicyUrl: "https://example.com/privacy",
  personaNoticeUrl: "https://withpersona.com/legal/privacy-policy", faceCrop: true,
};

type StopFn = (err: { code?: string; status?: number; reason?: string; message?: string } | null) => string;
type LeadFn = (shop: { provider?: string; ready?: string; testShop?: boolean } | null) => string;

function loadStopLine(): { stopLine: StopFn; lead: LeadFn } {
  const g = globalThis as unknown as {
    React: unknown;
    ReactDOM: { createPortal: (node: unknown) => unknown };
    window: unknown;
    document: { body: { dataset: Record<string, string> }; addEventListener: () => void; removeEventListener: () => void };
    localStorage: { getItem: () => null; setItem: () => void; removeItem: () => void };
    CDOS: { CD: object; idvProviderCopy?: (shop: { provider?: string; ready?: string; testShop?: boolean } | null) => string; IdCheck?: { stopLine: StopFn } };
  };
  const CD = new Proxy({}, { get: () => "var(--cd-ink)" });
  g.React = React;
  g.ReactDOM = { createPortal: (node) => node };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.document = { body: { dataset: {} }, addEventListener() {}, removeEventListener() {} };
  g.CDOS = { CD };
  g.window = g;
  const src = readFileSync(join(root, "os-src/cdos-id-check.jsx"), "utf8");
  const code = transform(src, { presets: ["react"], filename: "cdos-id-check.jsx", sourceType: "script" }).code;
  if (!code) throw new Error("id check did not compile");
  new Function("React", "ReactDOM", "window", "document", "localStorage", code)(
    React, g.ReactDOM, g, g.document, g.localStorage,
  );
  const fn = g.CDOS.IdCheck && g.CDOS.IdCheck.stopLine;
  const lead = g.CDOS.idvProviderCopy;
  if (!fn || !lead) throw new Error("stop line is not on the ID check");
  return { stopLine: fn, lead };
}

const loaded = loadStopLine();
const stopLine = loaded.stopLine;
const lead = loaded.lead;

describe("identity check readiness", () => {
  it("maps a stopped check to the sentence the teller reads", () => {
    expect(stopLine({ code: "IDV_OFF" })).toBe("Identity checks are off for this shop. The owner turns them on in Settings, Clients and KYC.");
    expect(stopLine({ code: "PRIVACY_CONTACT", message: "Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC." }))
      .toBe("Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC.");
    expect(stopLine({ status: 503, reason: "not_available" })).toBe("Automatic ID check with Didit is not available for this shop. Check the ID by hand instead.");
    expect(stopLine({ code: "IDV_PROVIDER", message: "Automatic ID check with Didit is not available for this shop. Check the ID by hand instead." }))
      .toBe("Automatic ID check with Didit is not available for this shop. Check the ID by hand instead.");
    expect(stopLine({ code: "IDV_KEY", message: "Identity checks are not connected." })).toBe("Identity checks are not connected.");
    expect(stopLine({ code: "IDV_CAP", message: "This shop already has the maximum number of identity checks in progress." }))
      .toBe("This shop already has the maximum number of identity checks in progress.");
    expect(stopLine({ code: "IDV_TIER", message: "not available yet" })).toBe("not available yet");
    expect(stopLine({ code: "start_failed", message: "Something else" })).toBe("The ID check did not finish. Try again, or check the ID in person.");
  });

  it("names off, not a test shop, not configured, privacy, or ok", () => {
    const base = { checksEnabled: true, provider: "didit", testShop: true, env: {}, privacyIsReady: true, personaConnected: false };
    expect(idvReadyReason({ ...base, checksEnabled: false })).toBe("off");
    expect(idvReadyReason({ ...base, testShop: false })).toBe("not_test_shop");
    expect(idvReadyReason(base)).toBe("not_configured");
    expect(idvReadyReason({ ...base, provider: "persona", personaConnected: false })).toBe("not_configured");
    expect(idvReadyReason({ ...base, provider: "persona", personaConnected: true, env: STAGING, privacyIsReady: false })).toBe("privacy_missing");
    expect(idvReadyReason({ ...base, provider: "persona", personaConnected: true, env: STAGING, privacyIsReady: true })).toBe("ok");
    expect(idvReadyReason({ ...base, provider: "persona", personaConnected: true, privacyIsReady: false })).toBe("ok");
    expect(privacyReady(empty)).toBe(false);
    expect(privacyReady(filled)).toBe(true);
  });
});

describe("consent copy", () => {
  it("names the provider for the cashier, and leaves a missing read unknown", () => {
    const hand = "Automatic ID check with ";
    const instead = " is not available for this shop. Check the ID by hand instead.";
    expect(lead(null)).toBe("The identity check status is not available.");
    expect(lead({ provider: "persona", ready: "off" })).toBe("Identity checks are off.");
    expect(lead({ provider: "didit", ready: "off" })).toBe("Identity checks are off.");
    expect(lead({ provider: "persona", ready: "ok" })).toBe("Automatic ID check uses Persona.");
    expect(lead({ provider: "didit", ready: "ok" })).toBe("Automatic ID check uses Didit.");
    expect(lead({ provider: "didit", ready: "ok", testShop: true })).toBe("Automatic ID check uses Didit (test).");
    expect(lead({ provider: "persona", ready: "not_configured" })).toBe(hand + "Persona" + instead);
    expect(lead({ provider: "didit", ready: "not_configured" })).toBe(hand + "Didit" + instead);
    expect(lead({ provider: "didit", ready: "not_test_shop" })).toBe(hand + "Didit" + instead);
    expect(lead({ provider: "persona", ready: "privacy_missing" })).toBe("Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC.");
    expect(lead({ provider: "didit", ready: "privacy_missing" })).toBe("Automatic ID check needs the shop privacy contact first. The owner adds it in Settings, Clients and KYC.");
  });

  it("renders an old consent version as it was shown, and the current version without placeholders", () => {
    const oldPersona = consentCopy("notice", CONSENT_VERSION_PREVIOUS, empty);
    const nowPersona = consentCopy("notice", CONSENT_VERSION, empty);
    expect(oldPersona).toContain("[Shop legal name]");
    expect(oldPersona).toContain("Privacy policy: [link].");
    expect(oldPersona).toContain("Persona's privacy notice: [link].");
    expect(nowPersona).toContain("This shop");
    expect(nowPersona).toContain("the staff at this counter");
    expect(nowPersona).not.toContain("Privacy policy:");
    expect(nowPersona).not.toContain("[");
    const oldDidit = consentCopy("didit-notice", DIDIT_CONSENT_VERSION_PREVIOUS, empty);
    const nowDidit = consentCopy("didit-notice", DIDIT_CONSENT_VERSION, empty);
    expect(oldDidit).toContain("Privacy policy: [link].");
    expect(nowDidit).not.toContain("Privacy policy:");
    expect(nowDidit).toContain("the staff at this counter");
  });

  it("does not show a bracket placeholder to a customer", () => {
    const copies = [noticeCopy(empty), selfieConsentCopy(empty), diditNoticeCopy(empty), diditSelfieConsentCopy(empty)];
    for (const text of copies) {
      expect(text).not.toContain("[");
      expect(text).toContain("the staff at this counter");
    }
    expect(noticeCopy(empty)).not.toContain("Privacy policy:");
    expect(diditNoticeCopy(empty)).not.toContain("Privacy policy:");
    expect(noticeCopy(empty)).not.toContain("Persona's privacy notice:");
    expect(noticeCopy({ ...empty, legalName: null })).toContain("This shop");
    expect(noticeCopy(filled)).toContain("Privacy policy: https://example.com/privacy");
    expect(noticeCopy(filled)).toContain("Persona's privacy notice: https://withpersona.com/legal/privacy-policy");
    expect(diditNoticeCopy(filled)).toContain("Privacy policy: https://example.com/privacy");
    expect(diditNoticeCopy(filled)).not.toContain("[");
  });
});
