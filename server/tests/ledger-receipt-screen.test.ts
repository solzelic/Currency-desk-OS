/* The Transfers detail and its printed receipt show the ledger's own
   lines. Keeping the source strings while dropping the render stays red. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const React = require("react") as { createElement: (...args: unknown[]) => unknown };
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

const LINE = "Beneficiary receives: 10825 JPY";

const CD = new Proxy({}, { get: (_t, key) => "tok-" + String(key) });
const desk = {
  CDOS: {
    CD,
    Ic: () => null,
    fmt: (n: unknown) => String(n ?? ""),
    num: (n: unknown) => String(n ?? ""),
    deskPack: () => ({ homeCurrency: "CAD" }),
    reportingLimit: () => ({}),
    crossRate: () => 1,
    businessDate: () => "2026-10-20",
  } as Record<string, unknown>,
  open: (_u: string, _n: string, _f: string) => {
    const written: string[] = [];
    return {
      document: {
        write: (html: string) => { written.push(html); },
        close() {},
      },
      focus() {},
      written,
    };
  },
};
const documentStub = {
  addEventListener() {},
  removeEventListener() {},
  body: {},
  activeElement: null,
};
const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

function loadJsx(file: string, patch?: (src: string) => string) {
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = desk;
  g.React = React;
  g.ReactDOM = { createPortal: (node: unknown) => node };
  g.document = documentStub;
  g.localStorage = localStorage;
  let src = readFileSync(join(root, file), "utf8");
  if (patch) src = patch(src);
  const code = transform(src, { presets: ["react"], filename: file }).code;
  if (!code) throw new Error(file);
  new Function("React", "ReactDOM", "window", "document", "localStorage", code)(
    React,
    { createPortal: (node: unknown) => node },
    desk,
    documentStub,
    localStorage,
  );
}

loadJsx("os-src/cdos-transfers.jsx");
loadJsx("os-src/cdos-transfers-app.jsx", (src) => src.replace(
  "window.CDOS = Object.assign(window.CDOS || {}, { Transfers });",
  "window.CDOS = Object.assign(window.CDOS || {}, { Transfers, printReceipt });",
));

const transfer = {
  id: "t-yen",
  ref: "TR-YEN",
  receiptLines: [LINE],
  status: "created",
  direction: "send",
  date: "2026-10-20",
  createdBy: "M. Costa",
  pin: "4481",
  senderName: "A. Shah",
  beneficiaryId: "b1",
  corridor: "c1",
  method: "bank",
  partner: "Partner",
  recvAmt: 10825,
  payAmt: 100,
  ccy: "JPY",
  rate: 108.25,
  fee: 0,
  timeline: [],
};

function draw(fn: unknown, props: unknown) {
  return renderToStaticMarkup(React.createElement(fn as never, props));
}

it("renders the ledger receipt on the transfer, and prints those lines", () => {
  const detail = (desk.CDOS._transfers as { TransferDetail: unknown }).TransferDetail;
  const html = draw(detail, {
    t: transfer,
    beneficiaries: [],
    corridors: [],
    me: { name: "M. Costa", role: "Owner" },
    log() {},
    setTransfers() {},
    onClose() {},
    onReceipt() {},
  });
  expect(html).toContain('data-ledger-receipt="1"');
  expect(html).toContain(LINE);
  expect(html).not.toContain("10825.00");

  const opened = (desk.open as (u: string, n: string, f: string) => { written: string[] })("", "", "");
  const print = desk.CDOS.printReceipt as (...args: unknown[]) => void;
  const realOpen = desk.open;
  desk.open = () => opened;
  print(transfer, [], [], {}, () => {});
  desk.open = realOpen;
  const page = opened.written.join("");
  expect(page).toContain(LINE);
  expect(page).not.toContain("10825.00");
});
