import React, { useState, useMemo, useRef } from "react";
import { Lock, Smartphone, Search, Plus, Trash2, Download, Building2, LogOut, ChevronRight,
  Calculator as CalcIcon, Users, X, Lock as LockMini, Delete, AlertTriangle, ShieldCheck,
  Receipt, LayoutDashboard, Coins, ScrollText, Settings as Cog, IdCard, Printer, Upload } from "lucide-react";

const C = {
  ink: "#122231", inkSoft: "#1c3548", paper: "#F4F5F3", panel: "#FFFFFF",
  line: "#D9DEDA", lineSoft: "#E8EBE7", brass: "#B0822F", brassSoft: "#EBDDBF",
  text: "#1E2A33", mute: "#697680", flag: "#9A3B2E", flagSoft: "#F2E0DC",
  green: "#2E5E4E", greenSoft: "#DDEAE3", amber: "#9A6B1F", amberSoft: "#F5E8CF",
};
const TYPES = ["Currency Exchange", "Remittance — Send", "Remittance — Receive", "Cheque Cashing", "Money Order", "Bill Payment"];
const CCY = ["CAD", "USD", "EUR", "GBP", "INR", "PHP", "CNY", "MXN", "AED"];
const PER_CAD = { CAD: 1, USD: 0.731, EUR: 0.676, GBP: 0.581, INR: 62.4, PHP: 41.2, CNY: 5.28, MXN: 13.1, AED: 2.68 };
const cross = (i, o) => +(PER_CAD[o] / PER_CAD[i]).toFixed(4);
const THRESHOLD = 10000, TODAY = "2026-06-17";
const STAFF = [{ name: "J. Masri", role: "Owner" }, { name: "A. Singh", role: "Teller" }, { name: "M. Costa", role: "Teller" }, { name: "R. Haddad", role: "Teller" }];

const fmt = (n, c) => isNaN(n) || n === "" ? "" : new Intl.NumberFormat("en-CA", { style: "currency", currency: c || "CAD", maximumFractionDigits: 2 }).format(Number(n));
const num = (n) => new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(Number(n) || 0);
const dDiff = (a, b) => (new Date(b) - new Date(a)) / 86400000;

const seedRows = () => [
  { id: 1, date: "2026-06-17", customer: "Daniel Okafor", type: "Currency Exchange", inCcy: "CAD", inAmt: 2400, rate: 0.7255, outCcy: "USD", outAmt: 1741.2, fee: 18, teller: "A. Singh", notes: "" },
  { id: 2, date: "2026-06-17", customer: "Lucia Ferraro", type: "Remittance — Send", inCcy: "CAD", inAmt: 600, rate: 40.8, outCcy: "PHP", outAmt: 24480, fee: 9.99, teller: "M. Costa", notes: "Cebu pickup" },
  { id: 3, date: "2026-06-16", customer: "Northbridge Imports", type: "Currency Exchange", inCcy: "USD", inAmt: 14500, rate: 1.355, outCcy: "CAD", outAmt: 19647.5, fee: 120, teller: "R. Haddad", notes: "Invoice settlement" },
  { id: 4, date: "2026-06-16", customer: "Daniel Okafor", type: "Cheque Cashing", inCcy: "CAD", inAmt: 1850, rate: 1, outCcy: "CAD", outAmt: 1813, fee: 37, teller: "A. Singh", notes: "Payroll cheque" },
  { id: 5, date: "2026-06-15", customer: "Aran Voss", type: "Currency Exchange", inCcy: "CAD", inAmt: 9400, rate: 0.7255, outCcy: "USD", outAmt: 6819.7, fee: 70, teller: "Front Desk", notes: "" },
  { id: 6, date: "2026-06-17", customer: "Aran Voss", type: "Currency Exchange", inCcy: "CAD", inAmt: 9200, rate: 0.7255, outCcy: "USD", outAmt: 6674.6, fee: 68, teller: "Front Desk", notes: "" },
  { id: 7, date: "2026-06-15", customer: "Lucia Ferraro", type: "Currency Exchange", inCcy: "CAD", inAmt: 950, rate: 0.671, outCcy: "EUR", outAmt: 637.45, fee: 12, teller: "M. Costa", notes: "" },
];
const seedClients = () => ({
  "Daniel Okafor": { idType: "Driver's Licence", idNum: "DL 8841-220", idExpiry: "2028-04-01", photo: null },
  "Lucia Ferraro": { idType: "Passport", idNum: "X4521889", idExpiry: "2027-11-12", photo: null },
  "Northbridge Imports": { idType: "Business Number", idNum: "BN 77120", idExpiry: "2030-01-01", photo: null },
  "Aran Voss": { idType: "", idNum: "", idExpiry: "", photo: null }, // missing KYC on purpose
});

export default function App() {
  const [view, setView] = useState("login");
  return (
    <div style={{ background: C.paper, color: C.text, minHeight: "100%", fontFamily: "ui-sans-serif, system-ui, sans-serif" }} className="w-full">
      <style>{`@media print{body *{visibility:hidden!important}#rcpt,#rcpt *{visibility:visible!important}#rcpt{position:absolute;left:0;top:0;width:320px}}`}</style>
      {view === "login" && <Login onNext={() => setView("otp")} />}
      {view === "otp" && <Otp onBack={() => setView("login")} onNext={() => setView("app")} />}
      {view === "app" && <Workspace onLogout={() => setView("login")} />}
    </div>
  );
}

function Login({ onNext }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  return (
    <div className="min-h-screen flex items-stretch">
      <div className="hidden md:flex flex-col justify-between p-12 w-2/5" style={{ background: C.ink, color: "#EAF0F2" }}>
        <div className="flex items-center gap-3"><Building2 size={22} color={C.brass} /><span className="tracking-[0.2em] text-xs" style={{ color: C.brassSoft }}>MONEY SERVICES</span></div>
        <div><div className="text-4xl font-semibold leading-tight" style={{ letterSpacing: "-0.01em" }}>Toronto FX<br />& Money Services</div>
          <p className="mt-4 text-sm max-w-xs" style={{ color: "#9FB0B9" }}>Back-office terminal. Ledger, clients, compliance, and the books in one place.</p></div>
        <div className="text-xs" style={{ color: "#5E7079" }}>Internal terminal · Authorized staff only</div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6"><div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-1" style={{ color: C.brass }}><Lock size={15} /><span className="text-xs tracking-widest">SECURE SIGN-IN</span></div>
        <h1 className="text-2xl font-semibold mb-6" style={{ color: C.ink }}>Sign in to the workspace</h1>
        <label className="block text-xs mb-1" style={{ color: C.mute }}>Staff ID</label>
        <input value={u} onChange={(e) => setU(e.target.value)} placeholder="e.g. a.singh" className="w-full mb-4 px-3 py-2.5 rounded-md outline-none text-sm" style={{ background: C.panel, border: `1px solid ${C.line}` }} />
        <label className="block text-xs mb-1" style={{ color: C.mute }}>Password</label>
        <input value={p} onChange={(e) => setP(e.target.value)} type="password" placeholder="••••••••" className="w-full mb-6 px-3 py-2.5 rounded-md outline-none text-sm" style={{ background: C.panel, border: `1px solid ${C.line}` }} />
        <button onClick={onNext} className="w-full py-2.5 rounded-md text-sm font-medium flex items-center justify-center gap-2" style={{ background: C.ink, color: "#fff" }}>Continue <ChevronRight size={16} /></button>
        <p className="mt-4 text-xs" style={{ color: C.mute }}>Demo — any credentials work. Real sign-in would use a managed auth provider, never hand-rolled.</p>
        <p className="mt-8 text-xs text-center" style={{ color: "#B6BEB7" }}>Built by Saily</p>
      </div></div>
    </div>
  );
}
function Otp({ onBack, onNext }) {
  const DEMO = "418302"; const [d, setD] = useState(Array(6).fill("")); const refs = useRef([]);
  const set = (i, v) => { if (!/^\d?$/.test(v)) return; const n = [...d]; n[i] = v; setD(n); if (v && i < 5) refs.current[i + 1]?.focus(); };
  const ok = d.join("") === DEMO;
  return (<div className="min-h-screen flex items-center justify-center p-6"><div className="w-full max-w-sm">
    <div className="flex items-center gap-2 mb-1" style={{ color: C.brass }}><Smartphone size={15} /><span className="text-xs tracking-widest">TWO-STEP VERIFICATION</span></div>
    <h1 className="text-2xl font-semibold mb-2" style={{ color: C.ink }}>Enter your code</h1>
    <p className="text-sm mb-6" style={{ color: C.mute }}>We texted a 6-digit code to •••• ••• 4821.</p>
    <div className="flex gap-2 mb-4">{d.map((v, i) => (<input key={i} ref={(el) => (refs.current[i] = el)} value={v} onChange={(e) => set(i, e.target.value)} inputMode="numeric" maxLength={1} className="w-12 h-14 text-center text-xl rounded-md outline-none" style={{ background: C.panel, border: `1px solid ${ok ? C.brass : C.line}`, fontVariantNumeric: "tabular-nums" }} />))}</div>
    <div className="mb-6 px-3 py-2 rounded-md text-xs" style={{ background: C.brassSoft, color: "#6B5119" }}>Simulated: demo code is <b className="tracking-widest">{DEMO}</b>. Real SMS needs a backend + provider like Twilio.</div>
    <button onClick={onNext} disabled={!ok} className="w-full py-2.5 rounded-md text-sm font-medium flex items-center justify-center gap-2" style={{ background: ok ? C.ink : "#C2CAC4", color: "#fff", cursor: ok ? "pointer" : "not-allowed" }}>Verify & open workspace <ChevronRight size={16} /></button>
    <button onClick={onBack} className="w-full mt-3 text-xs" style={{ color: C.mute }}>← Back to sign-in</button>
  </div></div>);
}

function Workspace({ onLogout }) {
  const [rows, setRows] = useState(seedRows);
  const [clients, setClients] = useState(seedClients);
  const [audit, setAudit] = useState([{ ts: "2026-06-17 09:02", user: "System", action: "Day opened", detail: "Drawer floats loaded" }]);
  const [tab, setTab] = useState("ledger");
  const [q, setQ] = useState(""); const [tf, setTf] = useState("All"); const [client, setClient] = useState(null);
  const [me, setMe] = useState(STAFF[0]);
  const [perms, setPerms] = useState({ Teller: { canDelete: true, canExport: true, canViewReports: true, canEditKYC: true, canSettings: false } });
  const [settings, setSettings] = useState({ requireIdPhoto: false, structuringDays: 7 });
  const [calc, setCalc] = useState({ open: false, x: 360, y: 130 });
  const [receipt, setReceipt] = useState(null);

  const can = (k) => me.role === "Owner" ? true : !!perms.Teller[k];
  const log = (action, detail) => setAudit((a) => [{ ts: new Date().toLocaleString("en-CA", { hour12: false }).replace(",", ""), user: me.name, action, detail }, ...a].slice(0, 300));

  const update = (id, key, val) => setRows((r) => r.map((x) => {
    if (x.id !== id) return x;
    const row = { ...x, [key]: val };
    if (key === "inCcy" || key === "outCcy") row.rate = cross(row.inCcy, row.outCcy);
    if (["inCcy", "outCcy", "inAmt", "rate"].includes(key)) { const o = (Number(row.inAmt) || 0) * (Number(row.rate) || 0); row.outAmt = o ? +o.toFixed(2) : ""; }
    return row;
  }));
  const del = (row) => { setRows((r) => r.filter((x) => x.id !== row.id)); log("Deleted entry", `${row.customer || "—"} · ${fmt(row.inAmt, row.inCcy)}`); };
  const add = () => { const id = Date.now(); setRows((r) => [{ id, date: TODAY, customer: client || "", type: "Currency Exchange", inCcy: "CAD", inAmt: "", rate: cross("CAD", "USD"), outCcy: "USD", outAmt: "", fee: "", teller: me.name, notes: "" }, ...r]); log("New entry", "Blank transaction added"); };

  // ── compliance derivations
  const flags = useMemo(() => {
    const map = {};
    rows.forEach((row) => {
      const single = (Number(row.inAmt) || 0) >= THRESHOLD;
      const agg = rows.filter((o) => o.customer && o.customer === row.customer && dDiff(o.date, row.date) >= 0 && dDiff(o.date, row.date) <= settings.structuringDays)
        .reduce((s, o) => s + (Number(o.inAmt) || 0), 0);
      const str = !single && agg >= THRESHOLD;
      // KYC
      const rec = clients[row.customer];
      let kyc = "ok";
      if (!rec || !rec.idType || !rec.idNum) kyc = "missing ID";
      else if (rec.idExpiry && rec.idExpiry < TODAY) kyc = "ID expired";
      else if (settings.requireIdPhoto && !rec.photo) kyc = "photo needed";
      map[row.id] = { single, str, agg, kyc };
    });
    return map;
  }, [rows, clients, settings]);

  const alerts = useMemo(() => {
    const str = new Set(), idIssue = new Set(); let rpt = 0;
    rows.forEach((r) => { const f = flags[r.id]; if (!f) return; if (f.single) rpt++; if (f.str) str.add(r.customer); if (f.kyc !== "ok") idIssue.add(r.customer); });
    return { str: str.size, id: idIssue.size, rpt };
  }, [rows, flags]);

  const filtered = useMemo(() => rows.filter((x) => {
    const t = tf === "All" || x.type === tf, c = !client || x.customer === client;
    const blob = `${x.customer} ${x.teller} ${x.notes}`.toLowerCase();
    return t && c && (q === "" || blob.includes(q.toLowerCase()));
  }), [rows, q, tf, client]);

  const stats = useMemo(() => {
    const src = client ? rows.filter((r) => r.customer === client) : rows;
    return { n: src.length, vol: src.reduce((s, x) => s + (+x.inAmt || 0), 0), fees: src.reduce((s, x) => s + (+x.fee || 0), 0), rpt: src.filter((x) => (+x.inAmt || 0) >= THRESHOLD).length };
  }, [rows, client]);

  const exportCsv = () => {
    const head = ["Date", "Customer", "Type", "InCcy", "InAmt", "Rate", "OutCcy", "OutAmt", "Fee", "Teller", "Notes"];
    const lines = rows.map((x) => [x.date, x.customer, x.type, x.inCcy, x.inAmt, x.rate, x.outCcy, x.outAmt, x.fee, x.teller, x.notes].map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }); const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ledger.csv"; a.click(); log("Exported CSV", `${rows.length} rows`);
  };

  const TABS = [["ledger", "Ledger", ScrollText], ["clients", "Clients", Users], ["dashboard", "Dashboard", LayoutDashboard], ["dayclose", "Day Close", Coins], ["audit", "Audit", ShieldCheck], ["settings", "Settings", Cog]];
  const visTabs = TABS.filter(([k]) => (k === "dashboard" || k === "dayclose") ? can("canViewReports") : k === "settings" ? (me.role === "Owner" || perms.Teller.canSettings) : true);

  return (
    <div className="min-h-screen flex flex-col relative" style={{ overflow: "hidden" }}>
      <header className="flex items-center justify-between px-5 py-2.5 z-30" style={{ background: C.ink, color: "#EAF0F2" }}>
        <div className="flex items-center gap-3"><Building2 size={18} color={C.brass} />
          <div className="leading-tight"><div className="text-sm font-semibold">Toronto FX & Money Services</div>
            <div className="text-[11px]" style={{ color: "#8198A2" }}>Workspace · {new Date(TODAY).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })}</div></div></div>
        <div className="hidden lg:flex items-center gap-3 text-[11px]" style={{ color: "#9FB0B9" }}>
          <span className="flex items-center gap-1" style={{ color: C.brassSoft }}><LockMini size={11} /> Rates locked 14:30 · next 15:00</span>
          {["USD", "EUR", "PHP"].map((c) => <span key={c} style={{ fontVariantNumeric: "tabular-nums" }}>{c} {PER_CAD[c]}</span>)}</div>
        <div className="flex items-center gap-2">
          <select value={me.name} onChange={(e) => { const u = STAFF.find((s) => s.name === e.target.value); setMe(u); }} className="text-xs px-2 py-1.5 rounded-md outline-none" style={{ background: C.inkSoft, color: "#EAF0F2", border: "1px solid #2C4456" }}>
            {STAFF.map((s) => <option key={s.name} value={s.name}>{s.name} · {s.role}</option>)}</select>
          <button onClick={() => setCalc((c) => ({ ...c, open: true }))} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md" style={{ border: "1px solid #2C4456" }}><CalcIcon size={13} /><span className="hidden sm:inline">Calc</span></button>
          <button onClick={onLogout} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md" style={{ border: "1px solid #2C4456" }}><LogOut size={13} /></button>
        </div>
      </header>

      {/* tabs */}
      <div className="flex items-center gap-1 px-3 pt-2 z-20" style={{ background: C.ink }}>
        {visTabs.map(([k, label, I]) => (
          <button key={k} onClick={() => setTab(k)} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-t-md font-medium" style={{ background: tab === k ? C.paper : "transparent", color: tab === k ? C.ink : "#9FB0B9" }}>
            <I size={13} /> {label}{k === "ledger" && (alerts.str + alerts.id > 0) && <span className="ml-1 text-[10px] px-1 rounded-full" style={{ background: C.flag, color: "#fff" }}>{alerts.str + alerts.id}</span>}</button>
        ))}
      </div>

      <div className="flex-1 overflow-auto" style={{ background: C.paper }}>
        {tab === "ledger" && <Ledger {...{ rows: filtered, flags, stats, client, setClient, q, setQ, tf, setTf, add, del, update, exportCsv, can, alerts, setReceipt }} />}
        {tab === "clients" && <Clients {...{ rows, clients, setClients, setTab, setClient, settings, can, log }} />}
        {tab === "dashboard" && <Dashboard rows={rows} />}
        {tab === "dayclose" && <DayClose rows={rows} log={log} />}
        {tab === "audit" && <Audit audit={audit} />}
        {tab === "settings" && <SettingsView {...{ perms, setPerms, settings, setSettings, me, log }} />}
      </div>

      {calc.open && <FloatWindow title="Calculator" icon={CalcIcon} pos={calc} onMove={(x, y) => setCalc((c) => ({ ...c, x, y }))} onClose={() => setCalc((c) => ({ ...c, open: false }))} width={248}><CalcPanel /></FloatWindow>}
      {receipt && <ReceiptModal row={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

// ───────── Ledger ─────────
function Ledger({ rows, flags, stats, client, setClient, q, setQ, tf, setTf, add, del, update, exportCsv, can, alerts, setReceipt }) {
  return (<div>
    <div className="grid grid-cols-2 md:grid-cols-4 border-b" style={{ borderColor: C.line, background: C.panel }}>
      <Stat label={client ? `Transactions · ${client}` : "Transactions"} value={stats.n} />
      <Stat label="Pay-in volume (nominal)" value={fmt(stats.vol, "CAD")} mono />
      <Stat label="Fees collected" value={fmt(stats.fees, "CAD")} mono />
      <Stat label={`Reportable ≥ ${fmt(THRESHOLD, "CAD")}`} value={stats.rpt} flag={stats.rpt > 0} />
    </div>
    {(alerts.str > 0 || alerts.id > 0 || alerts.rpt > 0) && (
      <div className="flex flex-wrap gap-2 px-4 pt-3">
        {alerts.rpt > 0 && <Pill icon={AlertTriangle} c={C.flag} bg={C.flagSoft} t={`${alerts.rpt} reportable (≥ $10k)`} />}
        {alerts.str > 0 && <Pill icon={AlertTriangle} c={C.amber} bg={C.amberSoft} t={`${alerts.str} structuring watch — near-threshold totals`} />}
        {alerts.id > 0 && <Pill icon={IdCard} c={C.ink} bg={C.lineSoft} t={`${alerts.id} client(s) with ID issues`} />}
      </div>)}
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      {client && <span className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md" style={{ background: C.ink, color: "#fff" }}>Viewing {client} <button onClick={() => setClient(null)}><X size={13} /></button></span>}
      <div className="flex items-center gap-2 px-3 py-2 rounded-md flex-1 min-w-[180px]" style={{ background: C.panel, border: `1px solid ${C.line}` }}><Search size={15} color={C.mute} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, teller, notes" className="w-full outline-none text-sm bg-transparent" /></div>
      <select value={tf} onChange={(e) => setTf(e.target.value)} className="px-3 py-2 rounded-md text-sm outline-none" style={{ background: C.panel, border: `1px solid ${C.line}` }}><option>All</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
      <button onClick={add} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium text-white" style={{ background: C.ink }}><Plus size={15} /> New</button>
      {can("canExport") && <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm" style={{ border: `1px solid ${C.line}`, background: C.panel }}><Download size={15} /> Export</button>}
    </div>
    <div className="px-4 pb-6"><div className="min-w-[1040px] rounded-lg overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
      <table className="w-full border-collapse text-sm" style={{ background: C.panel }}>
        <thead><tr style={{ background: "#EFF2EE", color: C.mute }} className="text-left text-[11px] uppercase tracking-wide">
          {["Date", "Customer", "Type", "Pay-in", "Rate", "Pay-out (auto)", "Fee", "Teller", "Flags", ""].map((h, i) => <th key={i} className="px-2 py-2 font-medium" style={{ borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((x) => { const f = flags[x.id] || {}; return (
          <tr key={x.id} style={{ borderBottom: `1px solid ${C.lineSoft}` }}>
            <Cell w="100" v={x.date} on={(v) => update(x.id, "date", v)} type="date" />
            <Cell w="150" v={x.customer} on={(v) => update(x.id, "customer", v)} ph="Name" />
            <SelCell w="160" v={x.type} on={(v) => update(x.id, "type", v)} opts={TYPES} />
            <td className="px-1 py-1"><div className="flex items-center gap-1"><Sel v={x.inCcy} on={(v) => update(x.id, "inCcy", v)} opts={CCY} narrow /><Num v={x.inAmt} on={(v) => update(x.id, "inAmt", v)} ph="0.00" /></div></td>
            <Num w="70" v={x.rate} on={(v) => update(x.id, "rate", v)} ph="—" />
            <td className="px-1 py-1"><div className="flex items-center gap-1"><Sel v={x.outCcy} on={(v) => update(x.id, "outCcy", v)} opts={CCY} narrow /><span className="px-1.5 py-1 text-sm text-right" style={{ width: 88, color: C.green, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{x.outAmt === "" ? "—" : num(x.outAmt)}</span></div></td>
            <Num w="60" v={x.fee} on={(v) => update(x.id, "fee", v)} ph="0" />
            <Cell w="110" v={x.teller} on={(v) => update(x.id, "teller", v)} />
            <td className="px-1 py-1"><div className="flex flex-wrap gap-1">
              {f.single && <Tag c={C.flag} bg={C.flagSoft} t="RPT" title="Single transaction ≥ $10k — reportable" />}
              {f.str && <Tag c={C.amber} bg={C.amberSoft} t="STR" title={`Client's ${7}-day total is ${fmt(f.agg, "CAD")} — possible structuring`} />}
              {f.kyc && f.kyc !== "ok" && <Tag c={C.ink} bg={C.lineSoft} t="ID" title={f.kyc} />}
            </div></td>
            <td className="px-1 py-1"><div className="flex items-center gap-0.5">
              <button onClick={() => setReceipt(x)} title="Receipt" className="p-1 rounded hover:opacity-70"><Receipt size={14} color={C.mute} /></button>
              {can("canDelete") && <button onClick={() => del(x)} title="Delete" className="p-1 rounded hover:opacity-70"><Trash2 size={14} color={C.mute} /></button>}</div></td>
          </tr>); })}
          {rows.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-sm" style={{ color: C.mute }}>No entries match.</td></tr>}
        </tbody></table></div>
      <p className="mt-4 text-[11px]" style={{ color: "#A9B1AA" }}>Prototype · pay-out auto-computes from locked rate · STR watch sums each client's last 7 days · in-memory only · Built by Saily</p>
    </div></div>);
}

// ───────── Clients (KYC) ─────────
function Clients({ rows, clients, setClients, setTab, setClient, settings, can, log }) {
  const [s, setS] = useState(""); const [open, setOpen] = useState(null);
  const agg = useMemo(() => {
    const m = {};
    rows.forEach((x) => { const k = x.customer || "—"; if (!m[k]) m[k] = { name: k, n: 0, vol: 0, fees: 0 }; m[k].n++; m[k].vol += +x.inAmt || 0; m[k].fees += +x.fee || 0; });
    Object.keys(clients).forEach((k) => { if (!m[k]) m[k] = { name: k, n: 0, vol: 0, fees: 0 }; });
    return Object.values(m).sort((a, b) => b.vol - a.vol);
  }, [rows, clients]);
  const status = (name) => { const r = clients[name]; if (!r || !r.idType || !r.idNum) return ["missing ID", C.flag, C.flagSoft]; if (r.idExpiry && r.idExpiry < TODAY) return ["ID expired", C.flag, C.flagSoft]; if (settings.requireIdPhoto && !r.photo) return ["photo needed", C.amber, C.amberSoft]; return ["verified", C.green, C.greenSoft]; };
  const shown = agg.filter((c) => c.name.toLowerCase().includes(s.toLowerCase()));
  const setField = (name, key, val) => setClients((c) => ({ ...c, [name]: { ...(c[name] || {}), [key]: val } }));
  const upload = (name, file) => { const r = new FileReader(); r.onload = () => { setField(name, "photo", r.result); log("ID photo saved", name); }; r.readAsDataURL(file); };

  return (<div className="p-4">
    <div className="flex items-center gap-2 mb-3"><div className="flex items-center gap-2 px-3 py-2 rounded-md flex-1 max-w-md" style={{ background: C.panel, border: `1px solid ${C.line}` }}><Search size={15} color={C.mute} /><input value={s} onChange={(e) => setS(e.target.value)} placeholder="Search clients…" className="w-full outline-none text-sm bg-transparent" /></div></div>
    <div className="grid md:grid-cols-2 gap-2">{shown.map((c) => { const [st, col, bg] = status(c.name); const rec = clients[c.name] || {}; const isOpen = open === c.name; return (
      <div key={c.name} className="rounded-lg" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
        <button onClick={() => setOpen(isOpen ? null : c.name)} className="w-full text-left px-4 py-3">
          <div className="flex items-center justify-between"><span className="font-medium" style={{ color: C.ink }}>{c.name}</span><span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: bg, color: col }}>{st}</span></div>
          <div className="flex gap-3 mt-1 text-[11px]" style={{ color: C.mute, fontVariantNumeric: "tabular-nums" }}><span>{c.n} txns</span><span>vol {fmt(c.vol, "CAD")}</span><span>fees {fmt(c.fees, "CAD")}</span></div>
        </button>
        {isOpen && <div className="px-4 pb-4 border-t" style={{ borderColor: C.lineSoft }}>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <Field label="ID type"><select disabled={!can("canEditKYC")} value={rec.idType || ""} onChange={(e) => setField(c.name, "idType", e.target.value)} className="w-full text-sm px-2 py-1.5 rounded outline-none" style={{ border: `1px solid ${C.line}`, background: C.paper }}><option value="">—</option>{["Driver's Licence", "Passport", "Provincial ID", "PR Card", "Business Number"].map((o) => <option key={o}>{o}</option>)}</select></Field>
            <Field label="ID number"><input disabled={!can("canEditKYC")} value={rec.idNum || ""} onChange={(e) => setField(c.name, "idNum", e.target.value)} className="w-full text-sm px-2 py-1.5 rounded outline-none" style={{ border: `1px solid ${C.line}`, background: C.paper }} /></Field>
            <Field label="Expiry"><input disabled={!can("canEditKYC")} type="date" value={rec.idExpiry || ""} onChange={(e) => setField(c.name, "idExpiry", e.target.value)} className="w-full text-sm px-2 py-1.5 rounded outline-none" style={{ border: `1px solid ${C.line}`, background: C.paper }} /></Field>
            <Field label="ID photo (optional)">
              {rec.photo ? <div className="flex items-center gap-2"><img src={rec.photo} alt="ID" className="h-10 rounded" style={{ border: `1px solid ${C.line}` }} /><button onClick={() => setField(c.name, "photo", null)} className="text-xs" style={{ color: C.flag }}>Remove</button></div>
                : <label className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded cursor-pointer" style={{ border: `1px dashed ${C.line}`, color: C.mute }}><Upload size={13} /> Upload<input type="file" accept="image/*" className="hidden" disabled={!can("canEditKYC")} onChange={(e) => e.target.files[0] && upload(c.name, e.target.files[0])} /></label>}
            </Field>
          </div>
          <button onClick={() => { setClient(c.name); setTab("ledger"); }} className="mt-3 text-xs px-3 py-1.5 rounded-md font-medium text-white" style={{ background: C.ink }}>View {c.n} transactions →</button>
          <p className="mt-2 text-[10px]" style={{ color: "#A9B1AA" }}>Demo: photo held in memory. Real: encrypted document store.</p>
        </div>}
      </div>); })}</div>
  </div>);
}

// ───────── Dashboard ─────────
function Dashboard({ rows }) {
  const d = useMemo(() => {
    const fees = rows.reduce((s, x) => s + (+x.fee || 0), 0), vol = rows.reduce((s, x) => s + (+x.inAmt || 0), 0);
    let margin = 0; rows.forEach((x) => { if (!x.inAmt || !x.outAmt) return; const mid = (+x.inAmt) * cross(x.inCcy, x.outCcy); const diff = mid - (+x.outAmt); if (diff > 0) margin += diff / (PER_CAD[x.outCcy] || 1); });
    const by = (key) => { const m = {}; rows.forEach((x) => { const k = x[key] || "—"; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const feesByTeller = {}; rows.forEach((x) => { feesByTeller[x.teller || "—"] = (feesByTeller[x.teller || "—"] || 0) + (+x.fee || 0); });
    const volByCcy = {}; rows.forEach((x) => { volByCcy[x.inCcy] = (volByCcy[x.inCcy] || 0) + (+x.inAmt || 0); });
    return { fees, vol, margin, byType: by("type"), feesByTeller: Object.entries(feesByTeller).sort((a, b) => b[1] - a[1]), volByCcy: Object.entries(volByCcy).sort((a, b) => b[1] - a[1]) };
  }, [rows]);
  return (<div className="p-4">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <Kpi label="Pay-in volume" value={fmt(d.vol, "CAD")} /><Kpi label="Fee revenue" value={fmt(d.fees, "CAD")} accent={C.green} />
      <Kpi label="Est. FX margin" value={fmt(d.margin, "CAD")} accent={C.green} /><Kpi label="Transactions" value={rows.length} />
    </div>
    <div className="grid md:grid-cols-3 gap-3">
      <BarCard title="Fees by teller" data={d.feesByTeller} fmtV={(v) => fmt(v, "CAD")} />
      <BarCard title="Volume by currency" data={d.volByCcy} fmtV={(v) => num(v)} />
      <BarCard title="Transactions by type" data={d.byType} fmtV={(v) => v} />
    </div>
    <p className="mt-3 text-[11px]" style={{ color: "#A9B1AA" }}>Est. FX margin = locked mid-rate value minus what was actually paid out, converted to CAD. Revenue = margin + fees.</p>
  </div>);
}

// ───────── Day Close ─────────
function DayClose({ rows, log }) {
  const ccys = useMemo(() => Array.from(new Set(rows.flatMap((r) => [r.inCcy, r.outCcy]))), [rows]);
  const [open, setOpen] = useState(() => Object.fromEntries(ccys.map((c) => [c, c === "CAD" ? 5000 : 2000])));
  const [counted, setCounted] = useState({});
  const calc = (c) => { const cashIn = rows.filter((r) => r.inCcy === c).reduce((s, r) => s + (+r.inAmt || 0), 0); const cashOut = rows.filter((r) => r.outCcy === c).reduce((s, r) => s + (+r.outAmt || 0), 0); const expected = (+open[c] || 0) + cashIn - cashOut; const cnt = counted[c]; const variance = cnt === undefined || cnt === "" ? null : (+cnt - expected); return { cashIn, cashOut, expected, variance }; };
  return (<div className="p-4">
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.line}`, background: C.panel }}>
      <table className="w-full text-sm border-collapse">
        <thead><tr style={{ background: "#EFF2EE", color: C.mute }} className="text-[11px] uppercase tracking-wide text-left"><th className="px-3 py-2">Currency</th><th className="px-3 py-2 text-right">Opening</th><th className="px-3 py-2 text-right">Cash in</th><th className="px-3 py-2 text-right">Cash out</th><th className="px-3 py-2 text-right">Expected</th><th className="px-3 py-2 text-right">Counted</th><th className="px-3 py-2 text-right">Variance</th></tr></thead>
        <tbody>{ccys.map((c) => { const r = calc(c); return (<tr key={c} style={{ borderTop: `1px solid ${C.lineSoft}` }}>
          <td className="px-3 py-2 font-medium" style={{ color: C.ink }}>{c}</td>
          <td className="px-2 py-1 text-right"><input type="number" value={open[c] ?? ""} onChange={(e) => setOpen((o) => ({ ...o, [c]: e.target.value }))} className="w-24 text-right px-2 py-1 rounded outline-none" style={{ border: `1px solid ${C.line}`, fontVariantNumeric: "tabular-nums" }} /></td>
          <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>{num(r.cashIn)}</td>
          <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>{num(r.cashOut)}</td>
          <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: "tabular-nums", color: C.ink }}>{num(r.expected)}</td>
          <td className="px-2 py-1 text-right"><input type="number" placeholder="count" value={counted[c] ?? ""} onChange={(e) => setCounted((o) => ({ ...o, [c]: e.target.value }))} className="w-24 text-right px-2 py-1 rounded outline-none" style={{ border: `1px solid ${C.line}`, fontVariantNumeric: "tabular-nums" }} /></td>
          <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: "tabular-nums", color: r.variance === null ? C.mute : r.variance === 0 ? C.green : C.flag }}>{r.variance === null ? "—" : (r.variance > 0 ? "+" : "") + num(r.variance)}</td>
        </tr>); })}</tbody></table></div>
    <button onClick={() => log("Day closed", `Drawer reconciled for ${ccys.length} currencies`)} className="mt-3 px-4 py-2 rounded-md text-sm font-medium text-white" style={{ background: C.ink }}>Close day & log</button>
    <p className="mt-2 text-[11px]" style={{ color: "#A9B1AA" }}>Expected = opening float + cash in − cash out. Demo runs over all logged entries.</p>
  </div>);
}

// ───────── Audit ─────────
function Audit({ audit }) {
  return (<div className="p-4"><div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.line}`, background: C.panel }}>
    <table className="w-full text-sm border-collapse"><thead><tr style={{ background: "#EFF2EE", color: C.mute }} className="text-[11px] uppercase tracking-wide text-left"><th className="px-3 py-2">Time</th><th className="px-3 py-2">Staff</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Detail</th></tr></thead>
      <tbody>{audit.map((a, i) => (<tr key={i} style={{ borderTop: `1px solid ${C.lineSoft}` }}><td className="px-3 py-2 whitespace-nowrap" style={{ color: C.mute, fontVariantNumeric: "tabular-nums" }}>{a.ts}</td><td className="px-3 py-2">{a.user}</td><td className="px-3 py-2 font-medium" style={{ color: C.ink }}>{a.action}</td><td className="px-3 py-2" style={{ color: C.mute }}>{a.detail}</td></tr>))}</tbody></table></div>
    <p className="mt-2 text-[11px]" style={{ color: "#A9B1AA" }}>Append-only log. Real version is tamper-evident and never editable — this is what makes the ledger examiner-ready.</p>
  </div>);
}

// ───────── Settings (owner) ─────────
function SettingsView({ perms, setPerms, settings, setSettings, me, log }) {
  if (me.role !== "Owner" && !perms.Teller.canSettings) return <div className="p-6 text-sm" style={{ color: C.mute }}>Owner access required.</div>;
  const toggle = (k) => { setPerms((p) => ({ ...p, Teller: { ...p.Teller, [k]: !p.Teller[k] } })); log("Permission changed", `Teller · ${k}`); };
  const CAPS = [["canDelete", "Delete transactions"], ["canExport", "Export data"], ["canViewReports", "View Dashboard & Day Close"], ["canEditKYC", "Edit client ID / KYC"], ["canSettings", "Open Settings"]];
  return (<div className="p-4 max-w-2xl">
    <Section title="Staff permissions" sub="Everyone starts with full access. Restrict the Teller role here if you want — Owner always has everything.">
      {CAPS.map(([k, label]) => (<div key={k} className="flex items-center justify-between py-2" style={{ borderTop: `1px solid ${C.lineSoft}` }}>
        <span className="text-sm">{label}</span>
        <button onClick={() => toggle(k)} className="w-11 h-6 rounded-full relative transition-colors" style={{ background: perms.Teller[k] ? C.green : "#CBD2CC" }}><span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all" style={{ left: perms.Teller[k] ? 22 : 2 }} /></button>
      </div>))}
    </Section>
    <Section title="Compliance settings" sub="Tune the rules to how this branch operates.">
      <div className="flex items-center justify-between py-2" style={{ borderTop: `1px solid ${C.lineSoft}` }}>
        <div><div className="text-sm">Require ID photo on file</div><div className="text-[11px]" style={{ color: C.mute }}>If on, clients without a photo are flagged.</div></div>
        <button onClick={() => { setSettings((s) => ({ ...s, requireIdPhoto: !s.requireIdPhoto })); log("Setting changed", `Require ID photo · ${!settings.requireIdPhoto}`); }} className="w-11 h-6 rounded-full relative" style={{ background: settings.requireIdPhoto ? C.green : "#CBD2CC" }}><span className="absolute top-0.5 w-5 h-5 rounded-full bg-white" style={{ left: settings.requireIdPhoto ? 22 : 2 }} /></button>
      </div>
      <div className="flex items-center justify-between py-2" style={{ borderTop: `1px solid ${C.lineSoft}` }}>
        <div><div className="text-sm">Structuring window</div><div className="text-[11px]" style={{ color: C.mute }}>Days of client activity summed against the $10k line.</div></div>
        <select value={settings.structuringDays} onChange={(e) => setSettings((s) => ({ ...s, structuringDays: +e.target.value }))} className="text-sm px-2 py-1.5 rounded outline-none" style={{ border: `1px solid ${C.line}`, background: C.paper }}>{[1, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
      </div>
    </Section>
  </div>);
}

// ───────── shared bits ─────────
function Stat({ label, value, mono, flag }) { return (<div className="px-5 py-3" style={{ borderRight: `1px solid ${C.lineSoft}` }}><div className="text-[11px]" style={{ color: C.mute }}>{label}</div><div className="text-lg font-semibold" style={{ color: flag ? C.flag : C.ink, fontVariantNumeric: mono ? "tabular-nums" : "normal" }}>{value}</div></div>); }
function Kpi({ label, value, accent }) { return (<div className="rounded-lg px-4 py-3" style={{ background: C.panel, border: `1px solid ${C.line}` }}><div className="text-[11px]" style={{ color: C.mute }}>{label}</div><div className="text-xl font-semibold" style={{ color: accent || C.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div></div>); }
function Pill({ icon: I, c, bg, t }) { return (<span className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md font-medium" style={{ background: bg, color: c }}><I size={13} /> {t}</span>); }
function Tag({ c, bg, t, title }) { return (<span title={title} className="text-[10px] px-1 rounded font-medium" style={{ background: bg, color: c }}>{t}</span>); }
function Field({ label, children }) { return (<div><div className="text-[11px] mb-1" style={{ color: C.mute }}>{label}</div>{children}</div>); }
function Section({ title, sub, children }) { return (<div className="mb-5 rounded-lg p-4" style={{ background: C.panel, border: `1px solid ${C.line}` }}><div className="font-semibold" style={{ color: C.ink }}>{title}</div>{sub && <div className="text-[11px] mt-0.5 mb-1" style={{ color: C.mute }}>{sub}</div>}{children}</div>); }
function BarCard({ title, data, fmtV }) { const max = Math.max(1, ...data.map((d) => d[1])); return (<div className="rounded-lg p-4" style={{ background: C.panel, border: `1px solid ${C.line}` }}><div className="text-sm font-semibold mb-3" style={{ color: C.ink }}>{title}</div>{data.map(([k, v]) => (<div key={k} className="mb-2"><div className="flex justify-between text-[11px] mb-0.5"><span style={{ color: C.text }}>{k}</span><span style={{ color: C.mute, fontVariantNumeric: "tabular-nums" }}>{fmtV(v)}</span></div><div className="h-2 rounded-full" style={{ background: C.lineSoft }}><div className="h-2 rounded-full" style={{ width: `${(v / max) * 100}%`, background: C.brass }} /></div></div>))}</div>); }

function Cell({ v, on, ph, w, type }) { return (<td className="px-1 py-1" style={{ width: w ? `${w}px` : "auto" }}><input value={v} onChange={(e) => on(e.target.value)} placeholder={ph} type={type || "text"} className="w-full px-1.5 py-1 rounded outline-none text-sm bg-transparent focus:bg-white" style={{ border: "1px solid transparent" }} onFocus={(e) => (e.target.style.border = `1px solid ${C.brass}`)} onBlur={(e) => (e.target.style.border = "1px solid transparent")} /></td>); }
function Num({ v, on, ph, w }) { return (<input value={v} onChange={(e) => on(e.target.value)} placeholder={ph} type="number" className="px-1.5 py-1 rounded outline-none text-sm bg-transparent focus:bg-white text-right" style={{ border: "1px solid transparent", width: w ? `${w}px` : "90px", fontVariantNumeric: "tabular-nums" }} onFocus={(e) => (e.target.style.border = `1px solid ${C.brass}`)} onBlur={(e) => (e.target.style.border = "1px solid transparent")} />); }
function Sel({ v, on, opts, narrow }) { return (<select value={v} onChange={(e) => on(e.target.value)} className="px-1 py-1 rounded outline-none text-sm bg-transparent focus:bg-white" style={{ border: "1px solid transparent", width: narrow ? "62px" : "auto" }}>{opts.map((o) => <option key={o}>{o}</option>)}</select>); }
function SelCell({ v, on, opts, w }) { return (<td className="px-1 py-1" style={{ width: w ? `${w}px` : "auto" }}><Sel v={v} on={on} opts={opts} /></td>); }

function FloatWindow({ title, icon: I, pos, onMove, onClose, children, width }) {
  const drag = useRef(null);
  const onDown = (e) => { const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y; drag.current = { sx, sy, ox, oy };
    const move = (ev) => { const d = drag.current; if (!d) return; onMove(Math.max(0, d.ox + ev.clientX - d.sx), Math.max(0, d.oy + ev.clientY - d.sy)); };
    const up = () => { drag.current = null; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); };
  return (<div className="absolute rounded-lg shadow-2xl select-none" style={{ left: pos.x, top: pos.y, width, zIndex: 60, background: C.panel, border: `1px solid ${C.line}` }}>
    <div onPointerDown={onDown} className="flex items-center justify-between px-3 py-2 rounded-t-lg cursor-grab active:cursor-grabbing" style={{ background: C.ink, color: "#EAF0F2" }}><div className="flex items-center gap-2 text-xs font-medium"><I size={14} color={C.brass} /> {title}</div><button onClick={onClose}><X size={15} /></button></div>
    {children}</div>);
}
function CalcPanel() {
  const [disp, setDisp] = useState("0"), [acc, setAcc] = useState(null), [op, setOp] = useState(null), [fresh, setFresh] = useState(true);
  const compute = (a, b, o) => o === "+" ? a + b : o === "−" ? a - b : o === "×" ? a * b : o === "÷" ? (b === 0 ? NaN : a / b) : b;
  const digit = (d) => { if (fresh) { setDisp(d === "." ? "0." : d); setFresh(false); } else { if (d === "." && disp.includes(".")) return; setDisp(disp + d); } };
  const operator = (o) => { const cur = parseFloat(disp); if (acc === null) setAcc(cur); else if (!fresh) { const r = compute(acc, cur, op); setAcc(r); setDisp(String(r)); } setOp(o); setFresh(true); };
  const equals = () => { if (op === null || acc === null) return; const r = compute(acc, parseFloat(disp), op); setDisp(String(isNaN(r) ? "Err" : +r.toFixed(6))); setAcc(null); setOp(null); setFresh(true); };
  const K = ({ label, on, kind }) => (<button onClick={on} className="h-11 rounded-md text-sm font-medium flex items-center justify-center" style={{ background: kind === "op" ? C.brassSoft : C.paper, color: C.ink, border: `1px solid ${C.line}` }}>{label}</button>);
  return (<div className="p-3"><div className="rounded-md px-3 py-3 mb-2 text-right text-2xl font-semibold overflow-hidden" style={{ background: C.ink, color: "#EAF0F2", fontVariantNumeric: "tabular-nums" }}>{disp}</div>
    <div className="grid grid-cols-4 gap-1.5">
      <K label="C" on={() => { setDisp("0"); setAcc(null); setOp(null); setFresh(true); }} /><K label={<Delete size={15} />} on={() => setDisp(fresh ? "0" : disp.length > 1 ? disp.slice(0, -1) : "0")} /><K label="%" on={() => setDisp(String(parseFloat(disp) / 100))} /><K label="÷" on={() => operator("÷")} kind="op" />
      {["7", "8", "9"].map((n) => <K key={n} label={n} on={() => digit(n)} />)}<K label="×" on={() => operator("×")} kind="op" />
      {["4", "5", "6"].map((n) => <K key={n} label={n} on={() => digit(n)} />)}<K label="−" on={() => operator("−")} kind="op" />
      {["1", "2", "3"].map((n) => <K key={n} label={n} on={() => digit(n)} />)}<K label="+" on={() => operator("+")} kind="op" />
      <K label="0" on={() => digit("0")} /><K label="." on={() => digit(".")} /><div className="col-span-2"><button onClick={equals} className="h-11 w-full rounded-md text-sm font-medium" style={{ background: C.ink, color: "#fff" }}>=</button></div>
    </div></div>);
}
function ReceiptModal({ row, onClose }) {
  return (<div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: "rgba(10,20,28,0.5)", zIndex: 80 }} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} className="rounded-lg overflow-hidden" style={{ width: 340, background: C.panel }}>
      <div id="rcpt" className="p-5" style={{ fontFamily: "ui-monospace, monospace" }}>
        <div className="text-center"><div className="font-semibold" style={{ color: C.ink }}>TORONTO FX & MONEY SERVICES</div><div className="text-[11px]" style={{ color: C.mute }}>Registered MSB · Toronto, ON</div></div>
        <div className="my-3" style={{ borderTop: `1px dashed ${C.line}` }} />
        <Line k="Date" v={row.date} /><Line k="Customer" v={row.customer || "—"} /><Line k="Type" v={row.type} /><Line k="Teller" v={row.teller} />
        <div className="my-3" style={{ borderTop: `1px dashed ${C.line}` }} />
        <Line k="Pay-in" v={`${num(row.inAmt)} ${row.inCcy}`} /><Line k="Rate" v={row.rate} /><Line k="Pay-out" v={`${num(row.outAmt)} ${row.outCcy}`} /><Line k="Fee" v={fmt(row.fee, "CAD")} />
        <div className="my-3" style={{ borderTop: `1px dashed ${C.line}` }} />
        <div className="text-center text-[11px]" style={{ color: C.mute }}>Thank you — keep for your records</div>
      </div>
      <div className="flex gap-2 p-3" style={{ borderTop: `1px solid ${C.line}` }}>
        <button onClick={() => window.print()} className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium text-white" style={{ background: C.ink }}><Printer size={14} /> Print</button>
        <button onClick={onClose} className="px-4 py-2 rounded-md text-sm" style={{ border: `1px solid ${C.line}` }}>Close</button>
      </div>
    </div></div>);
}
function Line({ k, v }) { return (<div className="flex justify-between text-sm py-0.5"><span style={{ color: C.mute }}>{k}</span><span style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{v}</span></div>); }
