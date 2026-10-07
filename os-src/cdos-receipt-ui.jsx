/* Receipts and Printer setup, plus the receipt a teller sees after a deal. */
(function () {
  const { useState, useEffect, useMemo } = React;
  const { CD, Ic } = window.CDOS;

  const SAMPLES = {
    JPY: { inAmt: "100.00", inCcy: "CAD", outAmt: "10000", outCcy: "JPY", rate: "100.00", fee: "2.50" },
    AED: { inAmt: "200.00", inCcy: "CAD", outAmt: "500.00", outCcy: "AED", rate: "2.50", fee: "3.00" },
    RSD: { inAmt: "50.00", inCcy: "CAD", outAmt: "4000.00", outCcy: "RSD", rate: "80.00", fee: "1.50" },
    USD: { inAmt: "100.00", inCcy: "CAD", outAmt: "73.00", outCcy: "USD", rate: "0.73", fee: "4.00" },
  };

  function useDesk() {
    const [desk, setDesk] = useState(null);
    const [err, setErr] = useState("");
    const reload = () => fetch("/api/desk/receipt-settings", { credentials: "same-origin" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setDesk(data); })
      .catch(() => {});
    useEffect(() => { reload(); }, []);
    const save = async (patch) => {
      setErr("");
      const res = await fetch("/api/desk/receipt-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.message || "Receipt setup was not saved.");
        return null;
      }
      setDesk(data);
      return data;
    };
    return { desk, setDesk, err, setErr, save, reload };
  }

  function Preview({ model }) {
    const html = window.CDOS.renderReceiptFragment(model);
    return <div data-receipt-preview="1" style={{ background: "#fff", color: "#000", border: "1px solid #111", overflow: "auto" }} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  function ReceiptSettings({ settings, set, me }) {
    const owner = me && me.role === "Owner";
    const api = useDesk();
    const opt = (api.desk && api.desk.options) || {};
    const idn = (api.desk && api.desk.identity) || {};
    const [form, setForm] = useState(null);
    const [sampleCcy, setSampleCcy] = useState("JPY");
    useEffect(() => {
      if (!api.desk || form) return;
      setForm({
        header: opt.header || settings.receiptHeader || "",
        footer: opt.footer || settings.receiptFooter || "",
        disclaimer: opt.disclaimer || settings.receiptDisclaimer || "",
        showRate: opt.showRate !== false,
        showFees: opt.showFees !== false,
        showClientName: opt.showClientName !== false,
        showQr: opt.showQr !== false,
        showLogo: opt.showLogo !== false && settings.showLogoOnReceipt !== false,
        showMsb: opt.showMsb !== false && settings.showMsbOnReceipt !== false,
        paper: opt.paper || "80mm",
        autoPrint: opt.autoPrint === true,
        offerEmail: opt.offerEmail === true,
        logo: opt.logo || settings.logo || null,
      });
    }, [api.desk]);
    const f = form || {
      header: settings.receiptHeader || "",
      footer: settings.receiptFooter || "",
      disclaimer: settings.receiptDisclaimer || "",
      showRate: true, showFees: true, showClientName: true, showQr: true,
      showLogo: settings.showLogoOnReceipt !== false,
      showMsb: settings.showMsbOnReceipt !== false,
      paper: "80mm", autoPrint: false, offerEmail: false, logo: settings.logo || null,
    };
    const patchForm = (patch) => setForm(Object.assign({}, f, patch));
    const persist = async (patch) => {
      const next = Object.assign({}, f, patch);
      setForm(next);
      if (patch.header != null && set) set("receiptHeader", next.header);
      if (patch.footer != null && set) set("receiptFooter", next.footer);
      if (patch.disclaimer != null && set) set("receiptDisclaimer", next.disclaimer);
      if (patch.showLogo != null && set) set("showLogoOnReceipt", next.showLogo);
      if (patch.showMsb != null && set) set("showMsbOnReceipt", next.showMsb);
      if (owner) await api.save(patch);
    };
    const sample = SAMPLES[sampleCcy] || SAMPLES.JPY;
    const model = useMemo(() => window.CDOS.modelFromRow({
      sample: true,
      ref: "SAMPLE",
      date: "Sample",
      customer: "Sample customer",
      inAmt: sample.inAmt,
      inCcy: sample.inCcy,
      outAmt: sample.outAmt,
      outCcy: sample.outCcy,
      rate: sample.rate,
      fee: sample.fee,
    }, Object.assign({}, settings, {
      receiptHeader: f.header,
      receiptFooter: f.footer,
      receiptDisclaimer: f.disclaimer,
      showLogoOnReceipt: f.showLogo,
      showMsbOnReceipt: f.showMsb,
      logo: f.logo,
    }), {
      options: f,
      identity: idn,
      qrDataUrl: f.showQr ? (api.desk && api.desk.qrDataUrl) : null,
    }), [f, sampleCcy, api.desk, settings]);
    const field = { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1px solid ${CD.line}`, borderRadius: 8, background: "transparent", color: CD.ink, fontSize: 13 };
    const onLogo = async (file) => {
      const taken = await window.CDOS.intakeIdImage(file);
      if (!taken.ok) { api.setErr(taken.why); return; }
      patchForm({ logo: taken.dataUrl, showLogo: true });
      if (set) set("logo", taken.dataUrl, "receipt logo");
      if (owner) await api.save({ logo: taken.dataUrl, showLogo: true });
    };
    return <div data-screen="receipts">
      <div className="text-sm font-medium" style={{ color: CD.ink }}>Receipts</div>
      <div className="text-[11px] mb-3" style={{ color: CD.mute }}>What the customer is handed. The preview is a sample, not a posted deal. Language follows the desk: {idn.language ? idn.language.label : "English"}.</div>
      {!owner && <div className="text-[12px] mb-2" style={{ color: CD.mute }}>Only the owner can change receipt setup.</div>}
      {api.err && <div className="text-[12px] mb-2" style={{ color: CD.flag || "#8a1f1f" }}>{api.err}</div>}
      <div className="cd-receipt-layout">
        <div data-receipt-sheet="1"><Preview model={model} /></div>
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <label className="text-[11px]" style={{ color: CD.mute }}>Sample payout currency</label>
          <select data-sample-ccy="1" value={sampleCcy} onChange={(e) => setSampleCcy(e.target.value)} className="text-sm mb-2" style={Object.assign({}, field, { marginTop: 4 })}>
            {Object.keys(SAMPLES).map((c) => <option key={c}>{c}</option>)}
          </select>
          <label className="text-[11px]" style={{ color: CD.mute }}>Header</label>
          <input disabled={!owner} value={f.header} placeholder={idn.shopName || "Shop name"} onChange={(e) => patchForm({ header: e.target.value })} onBlur={() => persist({ header: f.header })} style={Object.assign({}, field, { margin: "4px 0 8px" })} />
          <label className="text-[11px]" style={{ color: CD.mute }}>Footer</label>
          <input disabled={!owner} value={f.footer} placeholder={window.CDOS.receiptClosing({})} onChange={(e) => patchForm({ footer: e.target.value })} onBlur={() => persist({ footer: f.footer })} style={Object.assign({}, field, { margin: "4px 0 8px" })} />
          <label className="text-[11px]" style={{ color: CD.mute }}>Disclaimer</label>
          <textarea disabled={!owner} value={f.disclaimer} rows={2} onChange={(e) => patchForm({ disclaimer: e.target.value })} onBlur={() => persist({ disclaimer: f.disclaimer })} style={Object.assign({}, field, { margin: "4px 0 8px" })} />
          <label className="text-[11px]" style={{ color: CD.mute }}>Paper</label>
          <select disabled={!owner} data-paper="1" value={f.paper} onChange={(e) => persist({ paper: e.target.value })} style={Object.assign({}, field, { margin: "4px 0 8px" })}>
            <option value="80mm">80mm thermal</option>
            <option value="58mm">58mm thermal</option>
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
          {[
            ["showLogo", "Show logo"],
            ["showMsb", "Show licence / registration number"],
            ["showRate", "Show rate"],
            ["showFees", "Show fees"],
            ["showClientName", "Show client name"],
            ["showQr", "Show QR to the public rate page"],
            ["autoPrint", "Open the print dialog after a deal is posted"],
            ["offerEmail", "Offer email after each deal"],
          ].map(([key, label]) => <label key={key} className="flex items-center gap-2 text-[13px] mb-1" style={{ color: CD.ink }}>
            <input type="checkbox" disabled={!owner} checked={!!f[key]} onChange={(e) => persist({ [key]: e.target.checked })} /> {label}
          </label>)}
          <div className="mt-2 text-[12px]" style={{ color: CD.mute }}>
            Logo {f.logo ? "on file" : "not uploaded"}. {idn.cdId ? idn.cdId : "No CurrencyDesk ID issued yet"}.
          </div>
          {owner && <label className="text-[12px] inline-block mt-2" style={{ color: CD.ink, textDecoration: "underline", cursor: "pointer" }}>
            Upload logo
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const file = e.target.files && e.target.files[0]; if (file) onLogo(file); }} />
          </label>}
          {api.desk && api.desk.emailConfigured === false && <div className="text-[12px] mt-2" style={{ color: CD.mute }}>Receipt email is not set up on this desk.</div>}
        </div>
      </div>
    </div>;
  }

  function PrinterSetup({ me }) {
    const api = useDesk();
    const [pref, setPref] = useState(() => window.CDOS.loadPrinter());
    const [note, setNote] = useState("");
    const caps = window.CDOS.directAvailable();
    const help = (api.desk && api.desk.printerHelp) || window.CDOS.PRINTER_HELP;
    const owner = me && me.role === "Owner";
    const opt = (api.desk && api.desk.options) || {};
    const pick = (connection) => setPref(window.CDOS.savePrinter({ connection: connection }));
    const test = async () => {
      setNote("");
      const model = window.CDOS.modelFromRow({
        sample: true, ref: "TEST", date: "Test", customer: "Test",
        inAmt: "1.00", inCcy: "CAD", outAmt: "1.00", outCcy: "USD", rate: "1.00", fee: "0.00",
      }, {}, { options: opt, identity: (api.desk && api.desk.identity) || {}, qrDataUrl: null });
      try {
        const result = await window.CDOS.printModel(model);
        setNote(result.fallback ? "Direct print failed. The print dialog is open instead." : "Test sent.");
      } catch (e) {
        setNote("The test did not print. The print dialog is the fallback.");
      }
    };
    const drawer = async () => {
      const result = await window.CDOS.pulseDrawer();
      setNote(result.message);
    };
    const pair = async (kind) => {
      setNote("");
      pick(kind);
      try {
        if (kind === "usb") {
          if (!navigator.usb) throw new Error("This browser has no USB printing. Use the print dialog or AirPrint.");
          const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x04b8 }, { vendorId: 0x0519 }, { vendorId: 0x1504 }, { classCode: 0x07 }] });
          setPref(window.CDOS.savePrinter({ connection: "usb", label: device.productName || "USB printer", vendorId: device.vendorId, productId: device.productId }));
          setNote("Printer paired on this device.");
        } else if (kind === "serial") {
          if (!navigator.serial) throw new Error("This browser has no serial port. Use the print dialog.");
          await navigator.serial.requestPort();
          setPref(window.CDOS.savePrinter({ connection: "serial", label: "Serial printer" }));
          setNote("Serial port paired on this device.");
        } else if (kind === "bluetooth") {
          if (!navigator.bluetooth) throw new Error("This browser has no Bluetooth printing. Safari on iPhone and iPad uses AirPrint instead.");
          const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: ["000018f0-0000-1000-8000-00805f9b34fb", "e7810a71-73ae-499d-8c15-faa9aef0c3f2", "49535343-fe7d-4ae5-8fa9-9fafd205e455"],
          });
          setPref(window.CDOS.savePrinter({ connection: "bluetooth", label: device.name || "Bluetooth printer" }));
          setNote("Bluetooth printer paired on this device. Classic Bluetooth (SPP) still has to be a system printer.");
        }
      } catch (e) {
        setNote(e && e.message ? e.message : "The printer was not paired.");
      }
    };
    const btn = { border: `1px solid ${CD.line}`, borderRadius: 8, padding: "6px 10px", fontSize: 13, background: CD.panel, color: CD.ink };
    return <div data-screen="printer">
      <div className="text-sm font-medium" style={{ color: CD.ink }}>Printer setup</div>
      <div className="text-[11px] mb-3" style={{ color: CD.mute }}>The paired printer stays on this device. It is not copied to the desk's other tills.</div>
      {!caps.usb && !caps.bluetooth && <div className="text-[12px] mb-2" style={{ color: CD.ink }}>This browser cannot open USB or Bluetooth from a page. Use AirPrint or the print dialog.</div>}
      <div className="flex flex-wrap gap-2 mb-3">
        {[["browser", "Browser print"], ["usb", "USB"], ["serial", "Serial"], ["bluetooth", "Bluetooth"]].map(([id, label]) => <button key={id} data-connection={id} onClick={() => pick(id)} style={Object.assign({}, btn, pref.connection === id ? { background: CD.ink, color: "var(--cd-on-ink)" } : {})}>{label}</button>)}
      </div>
      <div className="text-[12px] mb-2" style={{ color: CD.mute }}>Paired: {pref.label || "none yet"} ({pref.connection || "browser"})</div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button data-action="pair-usb" onClick={() => pair("usb")} style={btn}>Pair USB</button>
        <button data-action="pair-serial" onClick={() => pair("serial")} style={btn}>Pair serial</button>
        <button data-action="pair-bluetooth" onClick={() => pair("bluetooth")} style={btn}>Pair Bluetooth</button>
        <button data-action="test-print" onClick={test} style={btn}>Test print</button>
        <button data-action="open-drawer" onClick={drawer} style={btn}>Open cash drawer</button>
      </div>
      <label className="flex items-center gap-2 text-[13px] mb-2" style={{ color: CD.ink }}>
        <input type="checkbox" checked={!!pref.autoDrawer} onChange={(e) => setPref(window.CDOS.savePrinter({ autoDrawer: e.target.checked }))} /> Open the cash drawer when a receipt prints
      </label>
      {owner && <label className="flex items-center gap-2 text-[13px] mb-3" style={{ color: CD.ink }}>
        <input type="checkbox" checked={opt.autoPrint === true} onChange={(e) => api.save({ autoPrint: e.target.checked })} /> Open the print dialog after a deal is posted
      </label>}
      {note && <div className="text-[12px] mb-2" style={{ color: CD.ink }}>{note}</div>}
      <pre data-printer-help="1" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12, lineHeight: 1.45, color: CD.text, margin: 0 }}>{help}</pre>
    </div>;
  }

  function DealReceipt({ row, settings, onClose }) {
    const [desk, setDesk] = useState(settings && settings.receiptDesk || null);
    const [emailOpen, setEmailOpen] = useState(false);
    const [to, setTo] = useState("");
    const [saveClient, setSaveClient] = useState(false);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      let alive = true;
      fetch("/api/desk/receipt-settings", { credentials: "same-origin" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!alive || !data) return;
          setDesk(data);
          if (data.options && data.options.offerEmail) setEmailOpen(true);
        })
        .catch(() => {});
      return () => { alive = false; };
    }, []);
    useEffect(() => {
      const email = (row && row.serverReceipt && row.serverReceipt.clientEmail) || (row && row.email) || "";
      if (email) setTo(email);
    }, [row]);
    const model = window.CDOS.modelFromRow(row, settings, desk);
    const configured = !desk || desk.emailConfigured !== false;
    const send = async () => {
      if (!row || !row.serverTransactionId) {
        setNote("This receipt is not on the ledger yet, so it cannot be emailed.");
        return;
      }
      setBusy(true);
      setNote("");
      try {
        const res = await fetch("/api/ledger/transactions/" + encodeURIComponent(row.serverTransactionId) + "/receipt/email", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: to.trim(), saveToClient: saveClient }),
        });
        const data = await res.json().catch(() => ({}));
        setNote(data.message || data.detail || (res.ok ? "Sent." : "The receipt email did not send. The deal is unchanged."));
      } catch (e) {
        setNote("The receipt email did not send. The deal is unchanged.");
      } finally {
        setBusy(false);
      }
    };
    const btn = { border: `1px solid ${CD.line}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, background: CD.panel, color: CD.ink };
    return <div className="fixed inset-0 flex items-center justify-center p-4" data-screen="deal-receipt" style={{ background: "var(--cd-scrim)", zIndex: 9000 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(440px, 100%)", maxHeight: "92vh", overflow: "auto", background: CD.panel, border: `1px solid ${CD.ink}` }}>
        <div style={{ background: "#fff" }} dangerouslySetInnerHTML={{ __html: window.CDOS.renderReceiptFragment(model) }} />
        <div className="flex flex-wrap gap-2 p-3" data-receipt-actions="1" style={{ borderTop: `1px solid ${CD.line}` }}>
          <button data-action="print" onClick={() => window.CDOS.printModel(model)} style={btn}>Print</button>
          <button data-action="pdf" onClick={() => window.CDOS.printModel(model)} style={btn}>Save PDF</button>
          {configured
            ? <button data-action="email" onClick={() => setEmailOpen(true)} style={btn}>Email</button>
            : <span className="text-[12px]" style={{ color: CD.mute }}>Receipt email is not set up on this desk.</span>}
          <button data-action="drawer" onClick={async () => { const r = await window.CDOS.pulseDrawer(); setNote(r.message); }} style={btn}>Drawer</button>
          <button onClick={onClose} style={btn}>Close</button>
        </div>
        {emailOpen && configured && <div className="px-3 pb-3">
          <div className="text-[11px] mb-1" style={{ color: CD.mute }}>Email this receipt</div>
          <input data-email-to="1" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1px solid ${CD.line}`, borderRadius: 8, marginBottom: 6 }} />
          <label className="flex items-center gap-2 text-[12px] mb-2" style={{ color: CD.ink }}>
            <input type="checkbox" checked={saveClient} onChange={(e) => setSaveClient(e.target.checked)} /> Save this address on the client
          </label>
          <button disabled={busy} onClick={send} style={Object.assign({}, btn, { background: CD.ink, color: "var(--cd-on-ink)" })}>{busy ? "Sending" : "Send receipt"}</button>
        </div>}
        {note && <div className="px-3 pb-3 text-[12px]" style={{ color: CD.ink }}>{note}</div>}
      </div>
    </div>;
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    ReceiptSettings: ReceiptSettings,
    PrinterSetup: PrinterSetup,
    DealReceipt: DealReceipt,
  });
})();
