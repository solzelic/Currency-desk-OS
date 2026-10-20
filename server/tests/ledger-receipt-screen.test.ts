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
    TODAY: "2026-10-20",
    deskPack: () => ({ homeCurrency: "CAD", packId: "pack-ca-v1" }),
    reportingLimit: () => ({ amount: null, currency: "CAD" }),
    crossRate: () => 1,
    businessDate: () => "2026-10-20",
    priceDeal: () => ({ outAmt: 10825, rate: 108.25, midRate: 108.25, marginCad: 0, side: "sell" }),
    newTx: (row: Record<string, unknown>) => ({ ...row, id: "tx-1", date: "2026-10-20", status: "ok" }),
    mkRef: () => "CD-REF",
    Backend: {
      asMoney: (n: unknown) => String(n),
      syncCustomer: async () => ({ customerId: "c1", externalRef: "e1" }),
      postRemittanceSend: async () => ({
        receipt: { lines: [LINE] },
        obligationRef: "OB1",
        transactionRef: "TX1",
        transactionId: "id1",
        obligationId: "ob1",
      }),
    },
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

loadJsx("os-src/cdos-transfers.jsx", (src) => src
  .replace("const [senderName, setSenderName] = useState('');", "const [senderName, setSenderName] = useState('A. Shah');")
  .replace("const [benId, setBenId] = useState('');", "const [benId, setBenId] = useState('b1');")
  .replace("const [partner, setPartner] = useState('');", "const [partner, setPartner] = useState('Partner');")
  .replace("const [payAmt, setPayAmt] = useState('');", "const [payAmt, setPayAmt] = useState('100');")
  .replace(
    "return (<Portal><div className=\"fixed inset-0 flex items-center justify-center p-4\" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }}",
    "window.__invokeCreate = create; return (<Portal><div className=\"fixed inset-0 flex items-center justify-center p-4\" style={{ background: 'var(--cd-scrim)', zIndex: 9200 }}",
  ));
loadJsx("os-src/cdos-transfers-app.jsx", (src) => src.replace(
  "window.CDOS = Object.assign(window.CDOS || {}, { Transfers });",
  "window.CDOS = Object.assign(window.CDOS || {}, { Transfers, printReceipt });",
));

function draw(fn: unknown, props: unknown) {
  return renderToStaticMarkup(React.createElement(fn as never, props));
}

it("posts a transfer and renders the ledger receipt, then prints those lines", async () => {
  let captured: { receiptLines?: string[] | null } | null = null;
  const modal = (desk.CDOS._transfers as { TransferModal: unknown }).TransferModal;
  draw(modal, {
    rows: [],
    setRows: (fn: (rows: unknown[]) => unknown[]) => fn([]),
    clients: { "A. Shah": { idType: "passport", idNum: "P123", idExpiry: "2030-01-01" } },
    setClients: () => {},
    settings: { transferRequirePurpose: false },
    me: { name: "M. Costa" },
    log() {},
    corridors: [{ id: "PH", ccy: "JPY", country: "Japan", flag: "", active: true, partners: [{ name: "Partner", methods: ["cash"] }] }],
    beneficiaries: [{ id: "b1", sender: "A. Shah", name: "Ben", corridor: "PH", method: "cash", partner: "Partner" }],
    setBeneficiaries() {},
    transfers: [],
    setTransfers: (fn: (rows: unknown[]) => Array<{ receiptLines?: string[] | null }>) => {
      captured = fn([])[0] ?? null;
    },
    onClose() {},
    serverBacked: true,
  });
  const invoke = (desk as unknown as { __invokeCreate?: () => Promise<void> }).__invokeCreate;
  if (!invoke) throw new Error("create was not reached");
  await invoke();
  if (!captured) throw new Error("the post did not record a transfer");
  const transfer = captured;

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

  const opened = desk.open("", "", "");
  const print = desk.CDOS.printReceipt as (...args: unknown[]) => void;
  const realOpen = desk.open;
  desk.open = () => opened;
  print(transfer, [], [], {}, () => {});
  desk.open = realOpen;
  const page = opened.written.join("");
  expect(page).toContain(LINE);
  expect(page).not.toContain("10825.00");
});
