/* ============================================================
   CurrencyDesk OS — added apps
   • Assistant  : in-OS chat window powered by window.claude.complete,
                  primed with a live snapshot of the desk.
   • LoanCalc   : amortised loan / payment calculator.
   Both register on window.CDOS so cdos-os.jsx can mount them.
   ============================================================ */
(function () {
  const { useState, useRef, useEffect, useMemo } = React;
  const { CD, Ic, fmt, num, crossRate, perCadLive } = window.CDOS;

  /* steel-blue identity for the AI feature (kept low-chroma, brand-adjacent) */
  const AI = { ink: '#2f5c8a', soft: '#eaf0f7', line: '#cfdcea', mute: '#5d7a9c' };

  /* ---------- live desk snapshot fed to the model ---------- */
  function deskSnapshot(rows, clients, alerts) {
    const live = (rows || []).filter(r => r.status !== 'void');
    const vol = live.reduce((s, r) => s + (+r.inAmt || 0), 0);
    const fees = live.reduce((s, r) => s + (+r.fee || 0), 0);
    let margin = 0;
    live.forEach(x => { if (!x.inAmt || !x.outAmt) return; const mid = (+x.inAmt) * crossRate(x.inCcy, x.outCcy); const diff = mid - (+x.outAmt); if (diff > 0) margin += diff / (perCadLive(x.outCcy) || 1); });
    const byCcy = {}; live.forEach(x => { byCcy[x.inCcy] = (byCcy[x.inCcy] || 0) + (+x.inAmt || 0); });
    const topCcy = Object.entries(byCcy).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, v]) => `${c} ${num(v)}`).join(', ');
    let rates = '';
    try {
      const cfg = JSON.parse(localStorage.getItem('yorkfx_rates_v1') || 'null');
      const list = (typeof CUR !== 'undefined' ? CUR : []).filter(c => c.code !== 'CAD').slice(0, 8);
      rates = list.map(c => { const r = cfg && cfg.rows && cfg.rows[c.code]; const mid = r && r.mid > 0 ? r.mid : (1 / c.perCadDefault); return `${c.code}=${mid.toFixed(4)} CAD`; }).join(', ');
    } catch (e) {}
    const locked = (() => { try { return localStorage.getItem('yorkfx_rates_locked') === '1'; } catch (e) { return false; } })();
    return [
      `Records: ${live.length}. Pay-in volume: ${fmt(vol, 'CAD')}. Fees: ${fmt(fees, 'CAD')}. Est. FX margin: ${fmt(margin, 'CAD')}.`,
      `Top pay-in currencies: ${topCcy || 'none yet'}.`,
      `Open compliance items — reportable (LCTR ≥ $10k): ${alerts.rpt}, possible structuring: ${alerts.str}, KYC/ID gaps: ${alerts.id}.`,
      `Mid rates (CAD per unit): ${rates || 'using defaults'}. Rate board is currently ${locked ? 'LOCKED' : 'LIVE'}.`,
      `Clients on file: ${Object.keys(clients || {}).length}.`
    ].join('\n');
  }

  const SYSTEM = (snap) => `You are the assistant inside CurrencyDesk OS — back-office software for a Canadian currency exchange house (a registered MSB). You help the teller/owner with their day: reading the ledger, explaining compliance (LCTR/large cash transaction reports at the CAD $10,000 threshold, 24h aggregation, structuring, KYC/ID requirements under FINTRAC), reasoning about FX margin and rates, and drafting short notes. Be concise, practical and plain-spoken — a few sentences or a tight list. Use CAD and real figures from the snapshot when relevant. You are not a lawyer; for edge cases say so briefly. Never invent transactions that aren't in the snapshot.

CURRENT DESK SNAPSHOT
${snap}`;

  function Bubble({ role, children }) {
    const me = role === 'user';
    return (
      <div style={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
        {!me && <div className="ai-av"><Ic n="sparkle" s={15} c="var(--cd-on-ink)" /></div>}
        <div style={{
          maxWidth: '78%', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: me ? CD.ink : 'var(--cd-panel)', color: me ? 'var(--cd-on-ink)' : CD.ink,
          border: me ? 'none' : `1px solid ${AI.line}`,
          borderRadius: me ? '14px 14px 4px 14px' : '14px 14px 14px 4px'
        }}>{children}</div>
      </div>
    );
  }

  function Assistant({ rows, clients, alerts, me }) {
    const [msgs, setMsgs] = useState([]);            // {role, content}
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const scroller = useRef(null);
    const snap = useMemo(() => deskSnapshot(rows, clients, alerts), [rows, clients, alerts]);

    useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy]);

    const CHIPS = [
      'Summarise today’s compliance flags',
      'How much have I made so far today?',
      'Which clients are missing ID?',
      'Explain the $10k LCTR rule simply'
    ];

    const send = async (text) => {
      const q = (text != null ? text : draft).trim();
      if (!q || busy) return;
      const next = [...msgs, { role: 'user', content: q }];
      setMsgs(next); setDraft(''); setBusy(true);
      try {
        const primed = [
          { role: 'user', content: SYSTEM(snap) + '\n\nReply only to my next message. Acknowledge with one short line.' },
          { role: 'assistant', content: `Ready — I'm watching the desk for you, ${me ? me.name.split(/[ .]/)[0] : 'there'}.` },
          ...next
        ];
        if (!(window.claude && window.claude.complete)) throw new Error('offline');
        const reply = await window.claude.complete({ messages: primed });
        setMsgs(m => [...m, { role: 'assistant', content: (reply || '').trim() || '…' }]);
      } catch (e) {
        setMsgs(m => [...m, { role: 'assistant', content: "I can't reach the model right now — this assistant only responds inside the live preview. Try again in a moment." }]);
      } finally { setBusy(false); }
    };

    return (
      <div className="ai-wrap">
        <div className="ai-head">
          <div className="ai-logo"><Ic n="sparkle" s={20} c="var(--cd-on-ink)" /></div>
          <div className="ai-id">
            <b>AI Assistant</b>
            <span>CurrencyDesk OS · trained on your desk</span>
          </div>
          <span className="ai-status"><span className="ai-dot"></span>Live</span>
        </div>

        <div className="ai-scroll" ref={scroller}>
          {msgs.length === 0 && (
            <div className="ai-empty">
              <div className="ai-logo big"><Ic n="sparkle" s={30} c="var(--cd-on-ink)" /></div>
              <div className="ai-empty-t">How can I help at the desk?</div>
              <div className="ai-empty-s">Ask about the ledger, compliance, rates or margins. I read your live numbers.</div>
              <div className="ai-chips">
                {CHIPS.map(c => <button key={c} className="ai-chip" onClick={() => send(c)}>{c}</button>)}
              </div>
            </div>
          )}
          {msgs.map((m, i) => <Bubble key={i} role={m.role}>{m.content}</Bubble>)}
          {busy && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div className="ai-av"><Ic n="sparkle" s={15} c="var(--cd-on-ink)" /></div>
              <div className="ai-typing"><span></span><span></span><span></span></div>
            </div>
          )}
        </div>

        <div className="ai-bar">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={1}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask the desk assistant…" className="ai-input" />
          <button className="ai-send" disabled={busy || !draft.trim()} onClick={() => send()} title="Send"><Ic n="send" s={16} c="var(--cd-on-ink)" /></button>
        </div>
      </div>
    );
  }

  /* ============================================================
     LOAN / PAYMENT CALCULATOR
     ============================================================ */
  const FREQ = [['12', 'Monthly'], ['26', 'Bi-weekly'], ['52', 'Weekly']];

  function LField({ label, suffix, children }) {
    return (<div className="ln-field"><div className="ln-lbl">{label}</div><div className="ln-input-wrap">{children}{suffix && <span className="ln-suffix">{suffix}</span>}</div></div>);
  }

  function LoanCalc() {
    const [amount, setAmount] = useState('25000');
    const [rate, setRate] = useState('7.5');
    const [years, setYears] = useState('5');
    const [ppy, setPpy] = useState('12');

    const calc = useMemo(() => {
      const P = parseFloat(amount) || 0;
      const annual = parseFloat(rate) || 0;
      const n = Math.max(1, Math.round((parseFloat(years) || 0) * (+ppy)));
      const i = annual / 100 / (+ppy);
      const pay = i === 0 ? P / n : P * i / (1 - Math.pow(1 + i, -n));
      const total = pay * n;
      const interest = total - P;
      // amortisation
      let bal = P; const sched = [];
      for (let k = 1; k <= n; k++) {
        const intP = bal * i; const prinP = pay - intP; bal = Math.max(0, bal - prinP);
        sched.push({ k, intP, prinP, bal });
      }
      return { P, n, i, pay, total, interest, sched };
    }, [amount, rate, years, ppy]);

    const freqLabel = (FREQ.find(f => f[0] === ppy) || ['', ''])[1].toLowerCase();
    const money = (v) => v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 });

    return (<div className="ln-wrap">
      <div className="ln-grid">
        {/* inputs */}
        <div className="ln-inputs">
          <div className="ln-title">Loan terms</div>
          <LField label="Loan amount" suffix="CAD"><input type="number" value={amount} onChange={e => setAmount(e.target.value)} className="ln-input" /></LField>
          <LField label="Annual interest rate" suffix="%"><input type="number" step="0.01" value={rate} onChange={e => setRate(e.target.value)} className="ln-input" /></LField>
          <LField label="Term" suffix="years"><input type="number" step="0.5" value={years} onChange={e => setYears(e.target.value)} className="ln-input" /></LField>
          <div className="ln-field"><div className="ln-lbl">Payment frequency</div>
            <div className="ln-seg">{FREQ.map(([v, l]) => <button key={v} className={'ln-seg-btn' + (ppy === v ? ' on' : '')} onClick={() => setPpy(v)}>{l}</button>)}</div>
          </div>
          <div className="ln-note">Amortised at a fixed rate. {calc.n} payments over {years || 0} year(s).</div>
        </div>

        {/* results */}
        <div className="ln-results">
          <div className="ln-headline">
            <div className="ln-headline-lbl">{freqLabel} payment</div>
            <div className="ln-headline-val">{money(calc.pay || 0)}</div>
          </div>
          <div className="ln-kpis">
            <div className="ln-kpi"><span>Principal</span><b>{money(calc.P)}</b></div>
            <div className="ln-kpi"><span>Total interest</span><b style={{ color: CD.flag }}>{money(calc.interest || 0)}</b></div>
            <div className="ln-kpi"><span>Total to repay</span><b>{money(calc.total || 0)}</b></div>
          </div>
          {/* principal vs interest bar */}
          <div className="ln-split">
            <div className="ln-split-bar">
              <div style={{ width: (calc.total ? (calc.P / calc.total) * 100 : 0) + '%', background: CD.ink }}></div>
              <div style={{ width: (calc.total ? (calc.interest / calc.total) * 100 : 0) + '%', background: CD.flag }}></div>
            </div>
            <div className="ln-split-leg"><span><i style={{ background: CD.ink }}></i>Principal</span><span><i style={{ background: CD.flag }}></i>Interest</span></div>
          </div>

          <div className="ln-sched-title">Amortisation schedule</div>
          <div className="ln-sched">
            <table>
              <thead><tr><th>#</th><th>Interest</th><th>Principal</th><th>Balance</th></tr></thead>
              <tbody>{calc.sched.map(r => (<tr key={r.k}><td>{r.k}</td><td>{num(r.intP)}</td><td>{num(r.prinP)}</td><td>{num(r.bal)}</td></tr>))}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>);
  }

  /* ============================================================
     APP STORE  (dynamic — free re-add + premium add-ons)
     ============================================================ */
  const STORE_DESC = {
    rates: 'Live buy/sell rate board, published to your storefront.',
    ledger: 'Immutable deal ledger with receipts and audit trail.',
    transfers: 'Remittance & wires: beneficiaries, corridors, lifecycle tracking and cross-border EFT reports.',
    cheques: 'Cheque cashing: capture, hold-and-clearance lifecycle, NSF/fraud risk and a fee schedule by type.',
    clients: 'Client directory, ID capture and KYC status.',
    dashboard: 'Volume, fees and FX margin at a glance.',
    dayclose: 'Count the till by denomination, reconcile and close the day.',
    till: 'Count the till by denomination, reconcile and close the day.',
    vault: 'Treasury: cash position, FX exposure, shift floats, replenishment and cost-basis P&L.',
    branches: 'Multi-branch network: per-branch cash position, inter-branch cash movement and consolidated reporting.',
    audit: 'Append-only, examiner-ready activity log.',
    calc: 'FX + plain calculator for the front desk.',
    loan: 'Amortised loan and payment calculator.',
    assistant: 'AI desk assistant trained on your live numbers.',
    reports: 'One-touch reports: summary, FINTRAC, revenue, register.',
    compliance: 'Sanctions screening, 24h aggregation, fileable submissions and pluggable jurisdiction packs.',
    tagged: 'Bookmarked transactions flagged for follow-up.',
    settings: 'Permissions, compliance rules and ticker tape.'
  };
  // upcoming modules — informational roadmap, not buyable (mirrors the build plan)
  const COMING = [
    { id: 'compliance_pro', title: 'Compliance AI Pro', icon: 'shield', desc: 'Live sanctions / PEP screening and auto-LCTR filing.', eta: 'Next' },
    { id: 'sms', title: 'SMS & 2FA', icon: 'smartphone', desc: 'Real text verification and customer pickup alerts.', eta: 'Soon' },
    { id: 'gold', title: 'Gold & precious metals', icon: 'coins', desc: 'Buy and sell gold at spot, booked to the ledger with the right precious-metals reporting.', eta: 'Next' },
    { id: 'crypto', title: 'Crypto desk', icon: 'globe', desc: 'Virtual-currency trades as a separate plug-in, with their own VCTR reporting.', eta: 'Later' }
  ];

  function StoreRow({ app, action, dim }) {
    return (<div className={'st-card' + (dim ? ' dim' : '')}>
      <div className="st-ico"><Ic n={app.icon} s={26} c="#17140F" /></div>
      <div className="st-meta">
        <div className="st-name">{app.title}</div>
        <div className="st-desc">{app.desc}</div>
        <div className="st-act">{action}</div>
      </div>
    </div>);
  }

  function AppStore({ installed, available, locked, plan, coming, onAdd, onRemove, onOpen, onUpgrade }) {
    const planName = { basic: 'Basic', pro: 'Pro', premium: 'Premium' }[plan] || '';
    return (<div className="st-wrap">
      <div className="st-head">
        <div className="st-logo"><Ic n="storefront" s={22} c="var(--cd-on-ink)" /></div>
        <div className="st-head-id">
          <div className="st-h1">Store</div>
          <div className="st-h2">Customise your dock and see what’s coming</div>
        </div>
        {planName && <div className="st-plan" style={{ marginLeft: 'auto', alignSelf: 'center', fontFamily: 'var(--f-mono, monospace)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--cd-on-ink-soft)', border: '1px solid var(--cd-on-ink-faint)', borderRadius: 999, padding: '5px 12px' }}>{planName} plan</div>}
      </div>
      <div className="st-body">
        {locked && locked.length > 0 && (<div className="st-section">
          <div className="st-sec-t">Unlock with a higher plan <span className="st-cnt">{locked.length}</span></div>
          <div className="st-note-line">These apps aren’t included in your {planName} plan. Upgrade to switch them on — your dock, data and settings stay exactly as they are.</div>
          <div className="st-grid">{locked.map(a => (<StoreRow key={a.id} app={a} dim
            action={<button className="st-btn add" onClick={() => onUpgrade && onUpgrade()}><Ic n="lock" s={14} c="var(--cd-on-ink)" /> Upgrade to unlock</button>} />))}</div>
        </div>)}
        {available.length > 0 && (<div className="st-section">
          <div className="st-sec-t">Add to your board <span className="st-cnt">{available.length}</span></div>
          <div className="st-note-line">Apps you’ve taken off the dock live here — add them back any time.</div>
          <div className="st-grid">{available.map(a => (<StoreRow key={a.id} app={a}
            action={<button className="st-btn add" onClick={() => onAdd(a.id)}><Ic n="download" s={14} c="var(--cd-on-ink)" /> Add to dock</button>} />))}</div>
        </div>)}

        <div className="st-section">
          <div className="st-sec-t">On your dock <span className="st-cnt">{installed.length}</span></div>
          <div className="st-grid">{installed.map(a => (<StoreRow key={a.id} app={a}
            action={<div className="st-row-acts">
              <button className="st-btn open" onClick={() => onOpen(a.id)}>Open</button>
              <button className="st-btn ghost" onClick={() => onRemove(a.id)}>Remove</button>
            </div>} />))}</div>
        </div>

        <div className="st-section">
          <div className="st-sec-t">Coming soon <span className="st-sec-sub">on the roadmap</span></div>
          <div className="st-grid">{coming.map(a => (<StoreRow key={a.id} app={a} dim
            action={<span className="st-soon">{a.eta || 'Soon'}</span>} />))}</div>
        </div>
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Assistant, LoanCalc, AppStore, COMING, STORE_DESC });
})();
