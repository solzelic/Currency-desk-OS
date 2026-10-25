/* Each desk path that counts an LCTR calls shared/lctr-reversal.js.
   Bypassing that call on the path drops the normal and no-reason cases. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const babel = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};
const React = require("react");
const root = resolve(import.meta.dirname, "../..");
const g = globalThis as any;

g.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, length: 0, key: () => null };
g.document = { addEventListener() {}, removeEventListener() {} };
require("../../shared/lctr-reversal.js");
require("../../shared/rolling-24h.js");
require("../../os-src/cdos-desk-time.js");
require("../../shared/id-document-types.js");
g.window = { CDOS: g.CDOS, CDOS_ID_TYPES: g.CDOS_ID_TYPES };
Object.assign(g.window.CDOS, {
  CD: {}, Ic: () => null, fmt: (n: unknown) => String(n ?? ""), num: (n: unknown) => String(n ?? ""),
  TODAY: "2026-06-16", crossRate: () => 1,
  counterCashIn: (r: { inAmt?: number; inCcy?: string }) => ({ amount: Number(r.inAmt) || 0, ccy: r.inCcy || "CAD" }),
  counterCashOut: () => null, businessDate: () => "2026-06-16",
  reportingLimit: () => ({ amount: 10000, currency: "CAD" }), dDiff: () => 0,
  TYPES: [], CCY: [], currencyPlaces: () => 2, effectiveRate: () => ({ text: "" }),
  RATE_NOTE: "", unitText: () => "", perCadLive: () => 1, Tag: () => null,
  branchZone: () => "America/Toronto", rulesMissing: () => false, deskPack: () => null,
});

function load(file: string) {
  const src = readFileSync(resolve(root, file), "utf8");
  const jsx = file.endsWith(".jsx");
  const code = jsx ? babel.transform(src, { presets: ["react"], filename: file }).code : src;
  if (!code) throw new Error(file);
  new Function("React", "window", "document", "localStorage", code)(React, g.window, g.document, g.localStorage);
}
load("os-src/cdos-compliance.jsx");
load("os-src/cdos-modules.jsx");
load("os-src/cdos-compliance-app.jsx");
load("os-src/cdos-backend.js");

const BOOKING = "booking error, cash not received";
const SETTINGS = {
  regime: "FINTRAC", structuringDays: 7, threshold: 10000,
  employees: [{ id: "usr_9", name: "A. Singh" }],
};
const engine = g.window.CDOS._compliance;
const regime = engine.getRegime(SETTINGS);

function deal(over: Record<string, unknown>) {
  return {
    id: "a", ref: "R-6000", date: "2026-06-15", time: "14:00", customer: "A. Chen", beneficiary: "",
    type: "Currency Exchange", receivedInstrument: "cash", disbursedInstrument: "cash",
    inCcy: "CAD", inAmt: 6000, outCcy: "USD", outAmt: 6000,
    status: "posted", voidReason: "", voidBy: "", voidByName: "", voidAt: "", ...over,
  };
}
function pair(reason: string) {
  return [
    deal({ status: "void", voidReason: reason, voidBy: "usr_9", voidAt: "2026-06-16T20:00:00.000Z" }),
    deal({ id: "b", ref: "R-5000", date: "2026-06-16", time: "10:00", inAmt: 5000, outAmt: 5000 }),
  ];
}

describe("desk paths use the shared LCTR reversal rule", () => {
  it("24h flags keep a normal reversal and a reversal with no reason, and drop a booking error", () => {
    const flags = (reason: string) => g.window.CDOS.computeFlags(pair(reason), {}, SETTINGS);
    expect(flags("Customer changed their mind").b.agg24).toBe(true);
    expect(flags("").b.agg24).toBe(true);
    expect(flags(BOOKING).b.agg24).toBe(false);
  });

  it("clusters keep a normal reversal and a reversal with no reason, and drop a booking error", () => {
    const total = (reason: string) => engine.aggClusters(pair(reason), regime, SETTINGS)
      .reduce((sum: number, cluster: { total: number }) => sum + cluster.total, 0);
    expect(total("Customer changed their mind")).toBe(11000);
    expect(total("")).toBe(11000);
    expect(total(BOOKING)).toBe(0);
  });

  it("the singles list keeps a normal reversal and a reversal with no reason, and drops a booking error", () => {
    const listed = (reason: string) => g.window.CDOS.computeReportables([
      deal({ id: "s", ref: "R-BIG", inAmt: 10000, outAmt: 10000, date: "2026-06-16", time: "12:00", status: "void", voidReason: reason }),
    ], {}, SETTINGS, [], {}).some((item: { refs: string[] }) => item.refs.includes("R-BIG"));
    expect(listed("Customer changed their mind")).toBe(true);
    expect(listed("")).toBe(true);
    expect(listed(BOOKING)).toBe(false);
  });

  it("counts a reversed deal in flags, singles, and clusters when the shared rule is missing", () => {
    const saved = g.window.CDOS.lctrReversal;
    g.window.CDOS.lctrReversal = null;
    try {
      const rows = pair("Customer changed their mind");
      const big = [deal({ id: "s", ref: "R-BIG", inAmt: 10000, outAmt: 10000, date: "2026-06-16", time: "12:00", status: "void", voidReason: "Customer changed their mind" })];
      const total = engine.aggClusters(rows, regime, SETTINGS).reduce((sum: number, c: { total: number }) => sum + c.total, 0);
      const listed = g.window.CDOS.computeReportables(big, {}, SETTINGS, [], {}).some((item: { refs: string[] }) => item.refs.includes("R-BIG"));
      expect({
        flags: g.window.CDOS.computeFlags(rows, {}, SETTINGS).b.agg24,
        clusters: total, singles: listed,
      }).toEqual({ flags: true, clusters: 11000, singles: true });
    } finally { g.window.CDOS.lctrReversal = saved; }
  });

  it("shows the left-out line for CAD 6000 left out and CAD 5000 kept, with the staff name and the branch clock", () => {
    const rows = pair(BOOKING);
    expect(engine.aggClusters(rows, regime, SETTINGS)).toEqual([]);
    const notes = engine.lctrLeftOut(rows, regime, SETTINGS);
    expect(notes).toEqual([{
      line: "left out: booking error, cash not received",
      by: "A. Singh", at: "16 Jun 2026, 4:00 pm",
      setBy: "Set by A. Singh, 16 Jun 2026, 4:00 pm.", ref: "R-6000",
    }]);
    const card = readFileSync(resolve(root, "os-src/cdos-compliance-app.jsx"), "utf8");
    expect(notes[0].line + ". " + notes[0].setBy).toBe("left out: booking error, cash not received. Set by A. Singh, 16 Jun 2026, 4:00 pm.");
    expect(card).toContain("strayLeftOut");
    expect(card).toContain('className="mt-2 text-[12px]" style={{ color: CD.mute }}');
    expect(card).toContain("{item.setBy}");
    const slip = readFileSync(resolve(root, "os-src/cdos-modules.jsx"), "utf8");
    const receipt = slip.slice(slip.indexOf("function ReceiptModal"), slip.indexOf("window.CDOS = Object.assign", slip.indexOf("function ReceiptModal")));
    expect(receipt).not.toContain("booking error");
    expect(receipt).not.toContain("left out:");
    expect(card).toContain("lctrReversal.reversedTag(t)");
    expect(card).toContain("<Tag c={CD.ink} bg={CD.chip} border={CD.line} t={tag}");
    const rule = g.window.CDOS.lctrReversal;
    expect(rule.reversedTag({ status: "void", voidReason: "Customer changed their mind" })).toBe("reversed");
    expect(rule.reversedTag({ status: "void", voidReason: BOOKING })).toBe("");
    expect(rule.reversedTag({ status: "posted" })).toBe("");
  });

  it("stores the display name and the 12-hour branch clock on the server row", () => {
    const row = g.window.CDOS.Backend.transactionToRow({
      transactionId: "t", transactionRef: "R", from: "CAD", to: "USD",
      inputAmount: "6000.00", outputAmount: "6000.00", rate: "1", feeCad: "0", spreadCad: "0",
      postedAt: "2026-06-15T18:00:00.000Z", dealKind: "exchange",
      reversal: {
        reversalId: "rv", reason: BOOKING, actorId: "usr_9", actorName: "A. Singh",
        postedAt: "2026-06-16T20:00:00.000Z",
      },
    }, "A. Chen");
    expect(row.voidBy).toBe("A. Singh");
    expect(row.voidAt).toBe("2026-06-16 4:00 pm");
    expect(row.voidBy).not.toBe("usr_9");
    expect(String(row.voidAt)).not.toContain("T");
  });
});

describe("a booking-error flag on the filing view", () => {
  const FILED_FLAG = "A deal in this report was later marked booking error. Check if the filed report needs a correction.";
  const PREPARED_FLAG = "A deal in this report was later marked booking error. Check the report before you file it.";
  const ReactDOMServer = require("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };

  it("shows the prepared text and the filed text, and neither text is on the receipt", () => {
    const rule = g.window.CDOS.lctrReversal;
    expect(rule.FILING_FLAG_PREPARED).toBe(PREPARED_FLAG);
    expect(rule.FILING_FLAG_FILED).toBe(FILED_FLAG);
    const view = g.window.CDOS.subFromFiling({ status: "draft", bookingErrorFlag: PREPARED_FLAG, reportCode: "LCTR", filingId: "fil-p" });
    const filed = g.window.CDOS.subFromFiling({ status: "filed", bookingErrorFlag: FILED_FLAG, reportCode: "LCTR", filingId: "fil-f" });
    expect(view.bookingErrorFlag).toBe(PREPARED_FLAG);
    expect(filed.bookingErrorFlag).toBe(FILED_FLAG);
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement("div", null,
      React.createElement(g.window.CDOS.FilingFlag, { text: view.bookingErrorFlag }),
      React.createElement(g.window.CDOS.FilingFlag, { text: filed.bookingErrorFlag }),
    ));
    expect(html).toContain(PREPARED_FLAG);
    expect(html).toContain(FILED_FLAG);
    expect(html).toContain("text-[12px]");
    const card = readFileSync(resolve(root, "os-src/cdos-compliance-app.jsx"), "utf8");
    expect(card).toContain("<FilingFlag text={sub && sub.bookingErrorFlag} />");
    expect(card).toContain("color: CD.onFlagSoft");
    const slip = readFileSync(resolve(root, "os-src/cdos-modules.jsx"), "utf8");
    const receipt = slip.slice(slip.indexOf("function ReceiptModal"), slip.indexOf("window.CDOS = Object.assign", slip.indexOf("function ReceiptModal")));
    expect(receipt).not.toContain(PREPARED_FLAG);
    expect(receipt).not.toContain(FILED_FLAG);
  });
});

describe("cashReceived follows the shared rule", () => {
  it("does not keep a second copy of the booking-error reason in SQL", () => {
    const src = readFileSync(resolve(root, "server/src/ledger/canada-rules.ts"), "utf8");
    expect(src).toContain("countsTowardLctr(row.reason)");
    expect(src).not.toContain("lctrCluster");
    expect(src).not.toContain("btrim($6");
  });
});
