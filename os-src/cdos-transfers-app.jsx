/* ============================================================
   CurrencyDesk OS — Transfers app shell
   Pipeline · Beneficiaries · Corridors · EFT reports, plus the
   root that owns the stores and the New-transfer button. Reads the
   data layer + modals from window.CDOS._transfers (cdos-transfers.jsx).
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, TODAY, crossRate, THRESHOLD } = window.CDOS;
  const T = window.CDOS._transfers;
  const { defaultCorridors, defaultBeneficiaries, defaultTransfers, BKEY, CKEY, TKEY, load,
    FLOW, STATUS, statusLabel, METHODS, methodLabel, StatusPill, cadOf, flagOf,
    BeneficiaryModal, TransferModal, TransferDetail } = T;
  const stamp = () => new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '');
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };
  const inputCls = 'w-full text-sm px-2.5 py-2 outline-none';
  function Field({ label, hint, children }) { return (<label className="block"><div className="text-[11px] mb-1 flex items-center justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</label>); }
  const SKEY = 'cdos_settlements_v1';

  /* ===================== PIPELINE ===================== */
  function Pipeline({ transfers, beneficiaries, corridors, onOpen, onNew, settings }) {
    const [filter, setFilter] = useState('active');
    const benName = (id) => { const b = beneficiaries.find(x => x.id === id); return b ? b.name : null; };
    const corOf = (id) => corridors.find(c => c.id === id) || {};
    const threshold = (settings && settings.threshold) || THRESHOLD;   // cross-border reporting line (Settings › Transfers)
    const counts = useMemo(() => {
      const c = { active: 0, hold: 0, paid: 0, all: transfers.length };
      transfers.forEach(t => { if (t.status === 'hold') c.hold++; else if (t.status === 'paid') c.paid++; else if (t.status !== 'cancelled') c.active++; });
      return c;
    }, [transfers]);
    const reportableOpen = transfers.filter(t => t.status !== 'cancelled' && t.status !== 'paid' && (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')) >= threshold).length;
    const list = useMemo(() => transfers.filter(t => {
      if (filter === 'all') return true;
      if (filter === 'hold') return t.status === 'hold';
      if (filter === 'paid') return t.status === 'paid';
      return t.status !== 'paid' && t.status !== 'cancelled';   // active
    }).sort((a, b) => (b.date + b.ref).localeCompare(a.date + a.ref)), [transfers, filter]);

    const FILTERS = [['active', 'In progress', counts.active], ['hold', 'On hold', counts.hold], ['paid', 'Paid out', counts.paid], ['all', 'All', counts.all]];
    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Transfer pipeline</div><div className="text-[11px]" style={{ color: CD.mute }}>Track every remittance from created to paid out.</div></div>
        <button onClick={onNew} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="send" s={15} c="var(--cd-on-ink)" /> New transfer</button>
      </div>

      {reportableOpen > 0 && <div className="flex items-center gap-2 px-3 py-2 mb-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 9 }}><Ic n="shield" s={14} c={CD.flag} /><span className="text-[12px]">{reportableOpen} open transfer{reportableOpen === 1 ? '' : 's'} ≥ {fmt(THRESHOLD, 'CAD')} — file the cross-border EFT report before month-end.</span></div>}

      <div className="flex flex-wrap gap-1.5 mb-3">
        {FILTERS.map(([id, label, n]) => <button key={id} onClick={() => setFilter(id)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium" style={{ borderRadius: 8, border: `1px solid ${filter === id ? 'transparent' : CD.line}`, background: filter === id ? CD.ink : 'transparent', color: filter === id ? 'var(--cd-on-ink)' : CD.mute }}>{label}{n > 0 && <span className="text-[10px] px-1 py-0.5" style={{ background: filter === id ? 'var(--cd-on-ink-faint)' : CD.lineSoft, borderRadius: 4, fontFamily: 'Space Mono' }}>{n}</span>}</button>)}
      </div>

      <div className="space-y-2">
        {list.map(t => { const cor = corOf(t.corridor); const dir = t.direction; const cadAmt = dir === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD'); const rpt = cadAmt >= threshold; return (
          <button key={t.id} onClick={() => onOpen(t.id)} className="w-full text-left p-3 flex items-center gap-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
            <span className="grid place-items-center flex-none" style={{ width: 38, height: 38, borderRadius: '50%', background: CD.lineSoft, fontSize: 18 }}>{cor.flag || '🌐'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold" style={{ color: CD.ink }}>{t.senderName}</span>
                <Ic n="arrowright" s={12} c={CD.faint} />
                <span className="text-[13px]" style={{ color: CD.ink }}>{dir === 'send' ? (benName(t.beneficiaryId) || cor.country) : t.senderName}</span>
                {rpt && <span className="text-[9px] px-1.5 py-0.5 font-semibold" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 4, fontFamily: 'Space Mono' }}>EFT</span>}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{t.ref} · {cor.country} · {methodLabel(t.method)} · {t.partner}</div>
            </div>
            <div className="text-right flex-none">
              <div className="text-[13px] font-semibold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(t.recvAmt)} {t.ccy}</div>
              <div className="mt-1"><StatusPill status={t.status} dir={dir} small /></div>
            </div>
          </button>); })}
        {!list.length && <div className="text-center py-14" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="send" s={26} c={CD.faint} /><div className="mt-2 text-sm font-medium" style={{ color: CD.ink }}>No transfers here</div><div className="text-[12px] mt-0.5">Start one with New transfer.</div></div>}
      </div>
    </div>);
  }

  /* ===================== BENEFICIARIES ===================== */
  function Beneficiaries({ beneficiaries, setBeneficiaries, corridors, log }) {
    const [q, setQ] = useState('');
    const [edit, setEdit] = useState(null);   // beneficiary or 'new'
    const corOf = (id) => corridors.find(c => c.id === id) || {};
    const shown = beneficiaries.filter(b => !q || (b.name + b.sender + b.partner).toLowerCase().includes(q.toLowerCase()));
    const save = (b) => { setBeneficiaries(list => { const ex = list.find(x => x.id === b.id); return ex ? list.map(x => x.id === b.id ? b : x) : [b, ...list]; }); setEdit(null); log && log('Beneficiary saved', `${b.name} · ${b.partner}`); };
    const remove = (id) => { setBeneficiaries(list => list.filter(x => x.id !== id)); };
    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 8 }}><Ic n="search" s={15} c={CD.mute} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search beneficiaries…" className="w-full outline-none text-sm bg-transparent" /></div>
        <button onClick={() => setEdit('new')} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white flex-none" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="userplus" s={15} c="var(--cd-on-ink)" /> New</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-2.5">
        {shown.map(b => { const cor = corOf(b.corridor); return (
          <div key={b.id} className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: CD.lineSoft, fontSize: 16 }}>{cor.flag || '🌐'}</span>
                <div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{b.name}</div><div className="text-[11px]" style={{ color: CD.mute }}>{b.relationship} of {b.sender}</div></div>
              </div>
              <div className="flex gap-0.5">
                <button onClick={() => setEdit(b)} title="Edit" className="p-1.5" style={{ borderRadius: 7 }}><Ic n="pencil" s={14} c={CD.mute} /></button>
                <button onClick={() => remove(b.id)} title="Remove" className="p-1.5" style={{ borderRadius: 7 }}><Ic n="trash" s={14} c={CD.faint} /></button>
              </div>
            </div>
            <div className="mt-2 pt-2 text-[11px] space-y-0.5" style={{ borderTop: `1px solid ${CD.lineSoft}`, color: CD.mute }}>
              <div>{cor.country} · {methodLabel(b.method)} · {b.partner}</div>
              {b.method === 'bank' && <div style={{ fontFamily: 'Space Mono, monospace' }}>{b.bank} · {b.account}</div>}
              {b.method === 'cash' && <div>Pickup · {b.pickupCity}</div>}
              {b.method === 'wallet' && <div style={{ fontFamily: 'Space Mono, monospace' }}>{b.walletId}</div>}
              {b.phone && <div>{b.phone}</div>}
            </div>
          </div>); })}
        {!shown.length && <div className="col-span-2 text-center py-12" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="users" s={24} c={CD.faint} /><div className="mt-2 text-[13px]">No beneficiaries{q ? ' match' : ' yet'}.</div></div>}
      </div>
      {edit && <BeneficiaryModal init={edit === 'new' ? null : edit} corridors={corridors} onClose={() => setEdit(null)} onSave={save} />}
    </div>);
  }

  /* ===================== CORRIDORS ===================== */
  function Corridors({ corridors, setCorridors, transfers, log }) {
    const vol = useMemo(() => { const m = {}; transfers.forEach(t => { if (t.status !== 'cancelled') m[t.corridor] = (m[t.corridor] || 0) + (t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD')); }); return m; }, [transfers]);
    const toggle = (id) => { setCorridors(list => list.map(c => c.id === id ? { ...c, active: !c.active } : c)); log && log('Corridor updated', id); };
    return (<div className="p-4">
      <div className="mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Corridors & payout partners</div><div className="text-[11px]" style={{ color: CD.mute }}>Where money lands and who pays it out. Toggle a corridor off to remove it from new transfers.</div></div>
      <div className="space-y-2">
        {corridors.map(c => (
          <div key={c.id} className="p-3" style={{ background: CD.panel, border: `1px solid ${c.active ? CD.line : CD.lineSoft}`, borderRadius: 11, opacity: c.active ? 1 : 0.6 }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span style={{ fontSize: 22 }}>{c.flag}</span>
                <div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{c.country} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {c.ccy}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{c.partners.length} partner{c.partners.length === 1 ? '' : 's'}{vol[c.id] ? ` · ${fmt(vol[c.id], 'CAD')} sent` : ''}</div></div>
              </div>
              <button onClick={() => toggle(c.id)} className="w-11 h-6 relative flex-none" style={{ background: c.active ? CD.ink : 'var(--cd-disabled)', borderRadius: 999, transition: 'background .15s' }}><span className="absolute top-0.5 w-5 h-5" style={{ left: c.active ? 22 : 2, background: 'var(--cd-panel)', borderRadius: 999, transition: 'left .15s' }} /></button>
            </div>
            <div className="mt-2.5 pt-2.5 flex flex-wrap gap-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              {c.partners.map(p => (
                <span key={p.name} className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px]" style={{ background: 'var(--cd-chip)', borderRadius: 7, color: CD.ink }}>
                  {p.name}
                  <span style={{ color: CD.faint }}>· {p.methods.map(m => methodLabel(m).split(' ')[0]).join('/')} · ~{p.etaH < 1 ? '<1h' : p.etaH < 24 ? p.etaH + 'h' : Math.round(p.etaH / 24) + 'd'}</span>
                </span>))}
            </div>
          </div>))}
      </div>
    </div>);
  }

  /* ===================== EFT REPORTS ===================== */
  function Reports({ transfers, beneficiaries, corridors, settings, me, log }) {
    const benName = (id) => { const b = beneficiaries.find(x => x.id === id); return b ? b.name : '—'; };
    const corOf = (id) => corridors.find(c => c.id === id) || {};
    const threshold = settings.threshold || THRESHOLD;
    const eft = useMemo(() => transfers.filter(t => t.status !== 'cancelled').map(t => ({ t, cad: t.direction === 'send' ? t.payAmt : cadOf(t.recvAmt, 'CAD') })).filter(x => x.cad >= threshold).sort((a, b) => b.cad - a.cad), [transfers]);
    const total = eft.reduce((s, x) => s + x.cad, 0);

    const print = () => {
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
      const biz = (settings.operatingName || settings.bizName) || 'CurrencyDesk';
      const rows = eft.map(({ t, cad }) => { const c = corOf(t.corridor); return `<tr><td class="mono">${esc(t.ref)}</td><td>${esc(t.date)}</td><td class="b">${esc(t.senderName)}</td><td>${esc(t.direction === 'send' ? benName(t.beneficiaryId) : 'inbound')}</td><td>${esc(c.flag || '')} ${esc(c.country || '')}</td><td class="mut">${esc(t.partner)}</td><td class="r">${fmt(cad, 'CAD')}</td><td class="r">${num(t.recvAmt)} <span class="mut">${esc(t.ccy)}</span></td><td class="mut">${esc(t.purpose)}</td></tr>`; }).join('');
      const w = window.open('', '_blank', 'width=1000,height=1100'); if (!w) { log && log('EFT report blocked', 'Allow pop-ups'); return; }
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cross-border EFT report</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:'Archivo',system-ui,sans-serif;margin:0;padding:34px 40px;color:#0a0a0a}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0a0a0a;padding-bottom:15px;margin-bottom:16px}.bd{display:flex;align-items:center;gap:9px}.logo{width:30px;height:30px;background:#0a0a0a;color:#fff;border-radius:7px;display:grid;place-items:center;font-family:'Space Mono';font-weight:700;font-size:13px}.wm{font-family:'Space Mono';font-weight:700;font-size:12px;letter-spacing:.04em}.h1{font-size:22px;font-weight:800;margin-top:11px}.meta{text-align:right;font-size:11px;color:#666;line-height:1.7}.meta b{color:#0a0a0a;font-family:'Space Mono'}
.note{background:#f7e1dd;border:1px solid #e3b6ad;border-radius:8px;padding:9px 12px;font-size:11px;color:#7a2e22;margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#e2e0d9;border:1px solid #e2e0d9;margin-bottom:18px}.kpi{background:#fff;padding:11px 14px}.kpi .l{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#777}.kpi .v{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
table{border-collapse:collapse;width:100%}th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#777;font-weight:600;padding:7px 9px;background:#f1f0ec;border-bottom:1px solid #ddd}td{font-size:11.5px;padding:6px 9px;border-bottom:1px solid #f0efe9}.r{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:'Space Mono';font-size:10px;color:#666}.mut{color:#999}.b{font-weight:600}
.ft{margin-top:14px;font-size:10px;color:#999}@page{margin:13mm}</style></head><body>
<div class="hd"><div><div class="bd"><span class="logo">CD</span><span class="wm">CURRENCYDESK OS</span></div><div class="h1">Cross-Border EFT Report</div></div>
<div class="meta"><b>${esc(biz)}</b><div>${esc(settings.msbNumber || '')}</div><div>Generated ${esc(stamp())}</div><div>By ${esc(me.name)} · ${esc(me.role)}</div></div></div>
<div class="note"><b>FINTRAC EFTR</b> — every international electronic funds transfer of ${fmt(threshold, 'CAD')} or more must be reported within five working days. This pack lists qualifying transfers for the period.</div>
<div class="kpis"><div class="kpi"><div class="l">Reportable transfers</div><div class="v">${eft.length}</div></div><div class="kpi"><div class="l">Total value (CAD)</div><div class="v">${fmt(total, 'CAD')}</div></div><div class="kpi"><div class="l">Threshold</div><div class="v">${fmt(threshold, 'CAD')}</div></div></div>
<table><thead><tr><th>Ref</th><th>Date</th><th>Sender</th><th>Beneficiary</th><th>Destination</th><th>Partner</th><th class="r">CAD value</th><th class="r">Payout</th><th>Purpose</th></tr></thead><tbody>${rows || '<tr><td colspan="9" style="padding:14px;color:#999">No reportable transfers in this period.</td></tr>'}</tbody></table>
<div class="ft">Generated by CurrencyDesk OS. Cross-border EFTs ≥ ${fmt(threshold, 'CAD')} (FINTRAC EFTR). Retain per record-retention policy.</div>
</body></html>`);
      w.document.close(); setTimeout(() => { w.focus(); w.print(); }, 400);
      log && log('EFT report generated', `${eft.length} transfers · ${fmt(total, 'CAD')}`);
    };

    return (<div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Cross-border EFT report</div><div className="text-[11px]" style={{ color: CD.mute }}>International transfers ≥ {fmt(threshold, 'CAD')} — the FINTRAC EFTR filing.</div></div>
        <button onClick={print} disabled={!eft.length} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: eft.length ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: eft.length ? 'pointer' : 'not-allowed' }}><Ic n="printer" s={15} c="var(--cd-on-ink)" /> Generate report</button>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Reportable</div><div className="text-xl font-bold" style={{ color: CD.ink }}>{eft.length}</div></div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Total value</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(total, 'CAD')}</div></div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>Threshold</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(threshold, 'CAD')}</div></div>
      </div>
      <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
        <table className="w-full text-sm border-collapse">
          <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left"><th className="px-3 py-2">Ref</th><th className="px-3 py-2">Sender</th><th className="px-3 py-2">Destination</th><th className="px-3 py-2 text-right">CAD value</th><th className="px-3 py-2">Status</th></tr></thead>
          <tbody>{eft.map(({ t, cad }) => { const c = corOf(t.corridor); return (
            <tr key={t.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              <td className="px-3 py-2" style={{ fontFamily: 'Space Mono', fontSize: 11.5, color: CD.mute }}>{t.ref}</td>
              <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}>{t.senderName}</td>
              <td className="px-3 py-2" style={{ color: CD.mute }}>{c.flag} {c.country}</td>
              <td className="px-3 py-2 text-right font-semibold" style={{ fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{fmt(cad, 'CAD')}</td>
              <td className="px-3 py-2"><StatusPill status={t.status} dir={t.direction} small /></td>
            </tr>); })}
            {!eft.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-[12px]" style={{ color: CD.faint }}>No transfers reach the reporting threshold.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>);
  }

  /* ===================== transfer receipt (print) ===================== */
  function printReceipt(t, beneficiaries, corridors, settings, log) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const ben = beneficiaries.find(b => b.id === t.beneficiaryId);
    const cor = corridors.find(c => c.id === t.corridor) || {};
    const biz = (settings.operatingName || settings.bizName) || 'CurrencyDesk';
    const w = window.open('', '_blank', 'width=420,height=720'); if (!w) { log && log('Receipt blocked', 'Allow pop-ups'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Transfer ${esc(t.ref)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:'Space Mono',monospace;margin:0;padding:24px 22px;color:#0a0a0a;max-width:360px}
.h{text-align:center;border-bottom:2px solid #0a0a0a;padding-bottom:12px;margin-bottom:12px}.h .b{font-family:'Archivo';font-weight:800;font-size:16px}.h .s{font-size:10px;color:#777;margin-top:2px;text-transform:uppercase;letter-spacing:.08em}
.pin{margin:12px 0;padding:10px;border:1px dashed #0a0a0a;border-radius:8px;text-align:center}.pin .l{font-size:9px;color:#777;text-transform:uppercase;letter-spacing:.1em}.pin .v{font-family:'Archivo';font-weight:800;font-size:22px;letter-spacing:.12em}
.r{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-top:1px solid #eee}.r .k{color:#777}.grn{color:#1f8a4c;font-weight:700}.big{text-align:center;margin:12px 0}.big .v{font-family:'Archivo';font-weight:800;font-size:26px}
.ft{margin-top:14px;border-top:1px dashed #ccc;padding-top:10px;font-size:9px;color:#999;text-align:center;line-height:1.5}@page{margin:8mm}</style></head><body>
<div class="h"><div class="b">${esc(biz)}</div><div class="s">Money transfer receipt</div></div>
<div class="r"><span class="k">Reference</span><span>${esc(t.ref)}</span></div>
<div class="r"><span class="k">Date</span><span>${esc(t.date)}</span></div>
<div class="r"><span class="k">Sender</span><span>${esc(t.senderName)}</span></div>
${ben ? `<div class="r"><span class="k">Beneficiary</span><span>${esc(ben.name)}</span></div>` : ''}
<div class="r"><span class="k">Destination</span><span>${esc(cor.flag || '')} ${esc(cor.country || '')}</span></div>
<div class="r"><span class="k">Payout</span><span>${esc(window.CDOS._transfers.methodLabel(t.method))} · ${esc(t.partner)}</span></div>
<div class="pin"><div class="l">Tracking PIN</div><div class="v">${esc(t.pin)}</div></div>
<div class="big"><div style="font-size:10px;color:#777">${t.direction === 'send' ? 'Beneficiary receives' : 'Customer receives'}</div><div class="v grn">${num(t.recvAmt)} ${esc(t.direction === 'send' ? t.ccy : 'CAD')}</div></div>
<div class="r"><span class="k">${t.direction === 'send' ? 'Paid in' : 'Amount in'}</span><span>${num(t.payAmt)} ${esc(t.direction === 'send' ? 'CAD' : t.ccy)}</span></div>
<div class="r"><span class="k">Rate</span><span>${num(t.rate)}</span></div>
<div class="r"><span class="k">Fee</span><span>${fmt(t.fee, 'CAD')}</span></div>
<div class="r"><span class="k">Status</span><span>${esc(statusLabel(t.status, t.direction))}</span></div>
<div class="ft">${esc(settings.receiptDisclaimer || 'Keep this receipt. Funds payable on presentation of the tracking PIN and valid ID.')}</div>
<script>setTimeout(function(){window.focus();window.print();},350)<\/script></body></html>`);
    w.document.close(); log && log('Transfer receipt printed', t.ref);
  }

  /* ===================== PARTNER SETTLEMENT ===================== */
  // Same conservation shape as Vault↔Till: a partner's net position is DERIVED
  // from posted records — committed payouts (transfers routed through them) drawn
  // down by float we've settled (wired) to them. If payouts > settled we owe them;
  // if settled > payouts we hold float on deposit. The corridor margin (customer
  // CAD collected − partner CAD cost) shows whether the wholesale FX nets out.
  function Settlement({ transfers, corridors, settlements, setSettlements, settings, me, log }) {
    const [settling, setSettling] = useState(null);   // { partner, corridor, ccy } or null
    const corOf = (id) => corridors.find(c => c.id === id) || {};
    // committed payouts per partner = transfers that have left (sent/transit/paid), in payout ccy
    const partners = useMemo(() => {
      const m = {};
      transfers.forEach(t => {
        if (t.direction !== 'send' || t.status === 'cancelled' || t.status === 'created') return;
        const key = t.corridor + '|' + t.partner;
        const p = m[key] || (m[key] = { partner: t.partner, corridor: t.corridor, ccy: t.ccy, payouts: 0, payoutN: 0, custCad: 0, paidN: 0 });
        p.payouts += +t.recvAmt || 0; p.payoutN++; p.custCad += (+t.payAmt || 0);
      });
      (settlements || []).forEach(s => { const key = s.corridor + '|' + s.partner; const p = m[key] || (m[key] = { partner: s.partner, corridor: s.corridor, ccy: s.ccy, payouts: 0, payoutN: 0, custCad: 0 }); });
      return Object.values(m).map(p => {
        const settled = (settlements || []).filter(s => s.partner === p.partner && s.corridor === p.corridor).reduce((a, s) => a + (+s.amount || 0), 0);
        const settledCad = (settlements || []).filter(s => s.partner === p.partner && s.corridor === p.corridor).reduce((a, s) => a + (+s.cadCost || 0), 0);
        const net = settled - p.payouts;                 // >0 float on deposit, <0 we owe
        const margin = p.custCad - settledCad;            // customer CAD in − partner CAD out (settled portion)
        return { ...p, settled, settledCad, net, margin };
      }).sort((a, b) => a.net - b.net);
    }, [transfers, settlements]);

    const totalOwed = partners.filter(p => p.net < 0).reduce((s, p) => s + cadOf(-p.net, p.ccy), 0);
    const totalFloat = partners.filter(p => p.net > 0).reduce((s, p) => s + cadOf(p.net, p.ccy), 0);

    const doSettle = (p, amount, fxRate, note) => {
      const amt = +amount || 0; if (!amt) return;
      const cadCost = +(amt * (fxRate || (crossRate(p.ccy, 'CAD') || 0))).toFixed(2);
      const ref = 'STL-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + ((settlements || []).filter(s => s.date === TODAY).length + 1).toString().padStart(2, '0');
      const rec = { id: 's' + Date.now(), ref, partner: p.partner, corridor: p.corridor, ccy: p.ccy, amount: amt, fxRate: +(+fxRate || crossRate(p.ccy, 'CAD')).toFixed(6), cadCost, date: TODAY, by: me.name, note: note || '' };
      setSettlements(list => [rec, ...(list || [])]);
      log && log('Partner settled', `${p.partner} · ${num(amt)} ${p.ccy} · ${fmt(cadCost, 'CAD')}`);
      setSettling(null);
    };

    return (<div className="p-4">
      <div className="mb-3"><div className="text-sm font-semibold" style={{ color: CD.ink }}>Partner settlement</div><div className="text-[11px]" style={{ color: CD.mute }}>What you owe each payout partner, derived from committed payouts and the float you've wired them.</div></div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="p-3" style={{ background: totalOwed > 0 ? CD.flagSoft : CD.panel, border: `1px solid ${totalOwed > 0 ? CD.flag : CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest flex items-center gap-1" style={{ color: totalOwed > 0 ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>{totalOwed > 0 && <Ic n="alert" s={11} c={CD.flag} />} Owed to partners</div>
          <div className="text-xl font-bold" style={{ color: totalOwed > 0 ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{fmt(totalOwed, 'CAD')}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>payouts not yet funded</div>
        </div>
        <div className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}>
          <div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Float on deposit</div>
          <div className="text-xl font-bold" style={{ color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{fmt(totalFloat, 'CAD')}</div>
          <div className="text-[10.5px]" style={{ color: CD.mute }}>prefunded with partners</div>
        </div>
      </div>

      <div className="space-y-2">
        {partners.map(p => { const cor = corOf(p.corridor); const owe = p.net < 0; return (
          <div key={p.corridor + p.partner} className="p-3" style={{ background: CD.panel, border: `1px solid ${owe ? CD.flag : CD.line}`, borderRadius: 11 }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: '50%', background: CD.lineSoft, fontSize: 15 }}>{cor.flag || '🌐'}</span>
                <div><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{p.partner}</div><div className="text-[11px]" style={{ color: CD.mute }}>{cor.country} · {p.payoutN} payout{p.payoutN === 1 ? '' : 's'} · {p.ccy}</div></div>
              </div>
              <button onClick={() => setSettling(p)} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white" style={{ background: CD.ink, borderRadius: 8 }}><Ic n="send" s={13} c="var(--cd-on-ink)" /> Settle</button>
            </div>
            <div className="grid grid-cols-4 gap-2 mt-2.5 pt-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
              {[['Paid out', `${num(p.payouts)} ${p.ccy}`, CD.ink], ['Settled', `${num(p.settled)} ${p.ccy}`, CD.mute], [owe ? 'We owe' : 'Float left', `${num(Math.abs(p.net))} ${p.ccy}`, owe ? CD.flag : CD.green], ['Corridor margin', fmt(p.margin, 'CAD'), p.margin >= 0 ? CD.green : CD.flag]].map(([l, v, c]) => (
                <div key={l}><div className="text-[9.5px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[12.5px] font-semibold" style={{ color: c, fontFamily: 'Space Mono, monospace', fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
            </div>
          </div>); })}
        {!partners.length && <div className="text-center py-12" style={{ border: `1px dashed ${CD.line}`, borderRadius: 12, color: CD.mute }}><Ic n="send" s={24} c={CD.faint} /><div className="mt-2 text-[13px]">No committed payouts yet — settlement starts once transfers are sent.</div></div>}
      </div>

      {settling && <SettleModal p={settling} corridor={corOf(settling.corridor)} onClose={() => setSettling(null)} onSettle={doSettle} />}
    </div>);
  }

  function SettleModal({ p, corridor, onClose, onSettle }) {
    const owe = p.net < 0;
    const [amount, setAmount] = useState(owe ? String(Math.round(-p.net)) : '');
    const mid = crossRate(p.ccy, 'CAD');
    const [fxRate, setFxRate] = useState(String(mid.toFixed(6)));
    const [note, setNote] = useState('');
    const amt = +amount || 0, rate = +fxRate || mid;
    const cadCost = +(amt * rate).toFixed(2);
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 440, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="send" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Settle {p.partner}</div><div className="text-[11px]" style={{ color: CD.mute }}>{corridor.country} · wire float to the partner</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between px-3 py-2" style={{ background: owe ? CD.flagSoft : 'var(--cd-chip)', borderRadius: 9 }}>
            <span className="text-[11.5px]" style={{ color: owe ? CD.flag : CD.mute }}>{owe ? 'Outstanding owed' : 'Float on deposit'}</span>
            <span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: owe ? CD.flag : CD.green }}>{num(Math.abs(p.net))} {p.ccy}</span>
          </div>
          <Field label={`Amount to wire (${p.ccy})`}><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder="0" className={inputCls} style={{ ...inputSty, textAlign: 'right', fontFamily: 'Space Mono' }} /></Field>
          <Field label="FX rate (CAD per unit)" hint={`spot ${mid.toFixed(6)}`}><input value={fxRate} onChange={e => setFxRate(e.target.value)} inputMode="decimal" className={inputCls} style={{ ...inputSty, textAlign: 'right', fontFamily: 'Space Mono' }} /></Field>
          <div className="flex items-center justify-between px-3 py-2" style={{ background: 'var(--cd-chip)', borderRadius: 9 }}><span className="text-[11.5px]" style={{ color: CD.mute }}>CAD cost of this wire</span><span className="text-[14px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink }}>{fmt(cadCost, 'CAD')}</span></div>
          <Field label="Reference / note"><input value={note} onChange={e => setNote(e.target.value)} placeholder="Wire ref, settlement batch…" className={inputCls} style={inputSty} /></Field>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
          <button onClick={() => amt > 0 && onSettle(p, amt, rate, note)} disabled={!(amt > 0)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: amt > 0 ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: amt > 0 ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> Record settlement</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== ROOT ===================== */
  function Transfers({ rows, setRows, clients, setClients, settings, me, log, beneficiaries: pBen, setBeneficiaries: pSetBen, corridors: pCor, setCorridors: pSetCor }) {
    const [tab, setTab] = useState('pipeline');
    // beneficiaries + corridors are lifted to the OS shell so Clients shares them;
    // fall back to local stores if mounted standalone.
    const [lBen, lSetBen] = useState(() => load(BKEY, defaultBeneficiaries));
    const [lCor, lSetCor] = useState(() => load(CKEY, defaultCorridors));
    const beneficiaries = pBen || lBen, setBeneficiaries = pSetBen || lSetBen;
    const corridors = pCor || lCor, setCorridors = pSetCor || lSetCor;
    const [transfers, setTransfers] = useState(() => load(TKEY, defaultTransfers));
    const [settlements, setSettlements] = useState(() => { try { return JSON.parse(localStorage.getItem(SKEY) || '[]') || []; } catch (e) { return []; } });
    const [modal, setModal] = useState(false);
    const [detailId, setDetailId] = useState(null);
    useEffect(() => { try { localStorage.setItem(SKEY, JSON.stringify(settlements)); } catch (e) {} }, [settlements]);
    useEffect(() => { if (!pSetBen) { try { localStorage.setItem(BKEY, JSON.stringify(lBen)); } catch (e) {} } }, [lBen]);
    useEffect(() => { if (!pSetCor) { try { localStorage.setItem(CKEY, JSON.stringify(lCor)); } catch (e) {} } }, [lCor]);
    useEffect(() => { try { localStorage.setItem(TKEY, JSON.stringify(transfers)); } catch (e) {} }, [transfers]);

    const detail = detailId ? transfers.find(t => t.id === detailId) : null;
    const inProgress = transfers.filter(t => t.status !== 'paid' && t.status !== 'cancelled').length;
    const onHold = transfers.filter(t => t.status === 'hold').length;
    // partner liability surfaced in the header so the owner sees it without digging
    const owed = useMemo(() => {
      const m = {};
      transfers.forEach(t => { if (t.direction === 'send' && t.status !== 'cancelled' && t.status !== 'created') { const k = t.corridor + '|' + t.partner; (m[k] = m[k] || { ccy: t.ccy, pay: 0, set: 0 }).pay += +t.recvAmt || 0; } });
      (settlements || []).forEach(s => { const k = s.corridor + '|' + s.partner; (m[k] = m[k] || { ccy: s.ccy, pay: 0, set: 0 }).set += +s.amount || 0; });
      return Object.values(m).reduce((a, p) => { const net = p.set - p.pay; return a + (net < 0 ? (p.ccy === 'CAD' ? -net : (-net) / (crossRate('CAD', p.ccy) || 1)) : 0); }, 0);
    }, [transfers, settlements]);
    const TABS = [['pipeline', 'Pipeline', 'send'], ['settlement', 'Settlement', 'coins'], ['beneficiaries', 'Beneficiaries', 'users'], ['corridors', 'Corridors', 'globe'], ['reports', 'EFT reports', 'shield']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="transferarrows" s={16} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Transfers</div><div className="text-[11px]" style={{ color: CD.mute }}>{inProgress} in progress{onHold ? ` · ${onHold} on hold` : ''}{owed > 0.5 ? ` · ${fmt(owed, 'CAD')} owed to partners` : ''}</div></div>
          </div>
          <button onClick={() => setModal(true)} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="plus" s={15} c="var(--cd-on-ink)" /> New transfer</button>
        </div>
        <div className="fld-bar" style={{ '--ft': '#1F7269', margin: '2px -16px 0', padding: '0 16px' }}>
          {TABS.map(([id, label, ic]) => { const badge = id === 'pipeline' && onHold ? onHold : 0; return (
            <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}>
              <Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}
              {badge > 0 && <span className="text-[9px] px-1 py-0.5" style={{ background: CD.flag, color: 'var(--cd-on-ink)', borderRadius: 4, fontFamily: 'Space Mono', marginLeft: 2 }}>{badge}</span>}
            </button>); })}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'pipeline' && <Pipeline transfers={transfers} beneficiaries={beneficiaries} corridors={corridors} onOpen={setDetailId} onNew={() => setModal(true)} settings={settings} />}
        {tab === 'settlement' && <Settlement transfers={transfers} corridors={corridors} settlements={settlements} setSettlements={setSettlements} settings={settings} me={me} log={log} />}
        {tab === 'beneficiaries' && <Beneficiaries beneficiaries={beneficiaries} setBeneficiaries={setBeneficiaries} corridors={corridors} log={log} />}
        {tab === 'corridors' && <Corridors corridors={corridors} setCorridors={setCorridors} transfers={transfers} log={log} />}
        {tab === 'reports' && <Reports transfers={transfers} beneficiaries={beneficiaries} corridors={corridors} settings={settings} me={me} log={log} />}
      </div>

      {modal && <TransferModal {...{ rows, setRows, clients, settings, me, log, corridors, beneficiaries, setBeneficiaries, transfers, setTransfers }} onClose={() => setModal(false)} onDone={(id) => { setModal(false); setTab('pipeline'); setDetailId(id); }} />}
      {detail && <TransferDetail t={detail} beneficiaries={beneficiaries} corridors={corridors} me={me} log={log} setTransfers={setTransfers} onClose={() => setDetailId(null)} onReceipt={(t) => printReceipt(t, beneficiaries, corridors, settings, log)} />}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Transfers });
})();
