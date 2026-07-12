/* ============================================================
   CurrencyDesk OS — Branch Network  (multi-branch / multi-till)
   The operating backbone the desk was missing: the network is a
   set of BRANCHES, each holding ONE VAULT (its cash account) and
   one or more TILLS (drawers floated from that vault). The main
   branch holds the MAIN VAULT — the network's cash root; every
   other branch's vault is a SUB-VAULT funded from it.

   Cash moves on one rail and always nets to zero:
     vault → till   (issue a float at open)
     till  → vault  (the day's cash returns, tallied)
     vault → vault  (an armoured run between branches)

   The OS shell reads the ACTIVE STATION (branch + till) from here,
   set at sign-in and switchable from the header; this module is the
   single source of truth for the station model, and the place
   head-office reads consolidated cash position & FX mix.
   ============================================================ */
(function () {
  const { useState, useMemo, useEffect } = React;
  const { CD, Ic, fmt, num, TODAY, crossRate, STAFF, ROLE_SCOPE } = window.CDOS;
  const Portal = ({ children }) => ReactDOM.createPortal(children, document.body);
  const flagOf = (c) => { try { return (typeof CUR !== 'undefined' ? (CUR.find(x => x.code === c) || {}).flag : '') || ''; } catch (e) { return ''; } };
  const cadOf = (a, c) => c === 'CAD' ? (+a || 0) : (+a || 0) * (crossRate(c, 'CAD') || 0);
  const SKEY = 'cdos_stations_v2', MKEY = 'cdos_branch_moves_v2';
  const BCCYS = ['CAD', 'USD', 'EUR', 'GBP', 'INR', 'PHP', 'CNY'];
  // on-brand grayscale ramp + one amber accent, for FX-mix stacks
  const TONE = { CAD: 'var(--cd-ink)', USD: '#3c3b38', EUR: '#615f58', GBP: '#86837b', INR: '#a8a59b', PHP: '#c6c2b8', CNY: CD.brass };

  /* ---- station model: branches → tills ----------------------------------
     Each till carries TWO people fields:
       teller   — who's POSTED here (management: their default drawer, set on
                  the Team board). Sticky.
       operator — who's ON it right now (a live session: set by sign-in /
                  till switch, cleared by sign-out). One operator per till. */
  /* ---- station model: branches → vault + tills ---------------------------
     Each branch carries a VAULT (its cash account; `main: true` marks the
     main vault). Each till carries TWO people fields:
       teller   — who's POSTED here (management: their default drawer, set on
                  the Team board). Sticky.
       operator — who's ON it right now (a live session: set by sign-in /
                  till switch, cleared by sign-out). One operator per till. */
  const TILL_CAP = 10;        // every location — base plan or enterprise — runs up to 10 tills
  const LOCATION_FEE = 699;   // enterprise: per location, per month
  function defaultBranches() {
    return [
      { id: 'b01', name: 'Front Desk 01', code: 'FD-01', city: 'Toronto — Adelaide St W', status: 'open', main: true, dealsToday: 23, volToday: 44277,
        vault: { CAD: 260000, USD: 84000, EUR: 30000, GBP: 8000, INR: 4200000, PHP: 1800000, CNY: 90000 }, tills: [
        { id: 'b01t1', name: 'Till 1 — Main counter', teller: 'A. Singh', operator: 'A. Singh', status: 'open', cash: { CAD: 120000, USD: 42000, EUR: 16000, GBP: 3200, INR: 2100000, PHP: 900000, CNY: 48000 } },
        { id: 'b01t2', name: 'Till 2 — Express',       teller: 'M. Costa', operator: 'M. Costa', status: 'open', cash: { CAD: 70000, USD: 26000, EUR: 9600, GBP: 2000, INR: 1300000, PHP: 560000, CNY: 30000 } },
        { id: 'b01t3', name: 'Wholesale desk',         teller: '', operator: '', status: 'open', cash: { CAD: 48500, USD: 16200, EUR: 6000, GBP: 1200, INR: 780000, PHP: 300000, CNY: 18000 } },
      ] },
      { id: 'b02', name: 'North York', code: 'NY-02', city: 'Toronto — Yonge & Sheppard', status: 'open', dealsToday: 17, volToday: 31840,
        vault: { CAD: 140000, USD: 40000, EUR: 12000, GBP: 3000, INR: 2000000, PHP: 800000, CNY: 30000 }, tills: [
        { id: 'b02t1', name: 'Till 1', teller: 'R. Haddad', operator: 'R. Haddad', status: 'open', cash: { CAD: 96000, USD: 31000, EUR: 9000, GBP: 2000, INR: 1600000, PHP: 600000, CNY: 26000 } },
        { id: 'b02t2', name: 'Till 2', teller: '', operator: '', status: 'open', cash: { CAD: 66000, USD: 20000, EUR: 5200, GBP: 1100, INR: 1000000, PHP: 380000, CNY: 16000 } },
      ] },
    ];
  }
  const tillCad = (t) => BCCYS.reduce((s, c) => s + cadOf((t.cash && t.cash[c]) || 0, c), 0);
  const vaultUnits = (b, c) => (b.vault && b.vault[c]) || 0;
  const vaultCad = (b) => BCCYS.reduce((s, c) => s + cadOf(vaultUnits(b, c), c), 0);
  const tillsCad = (b) => (b.tills || []).reduce((s, t) => s + tillCad(t), 0);
  const branchUnits = (b, c) => vaultUnits(b, c) + (b.tills || []).reduce((s, t) => s + ((t.cash && t.cash[c]) || 0), 0);
  const branchCad = (b) => vaultCad(b) + tillsCad(b);
  const defaultStation = (branches) => { const b = (branches || defaultBranches()).find(x => x.status === 'open') || branches[0]; const t = (b.tills || []).find(x => x.status === 'open') || b.tills[0]; return { branchId: b.id, tillId: t && t.id }; };

  const inputSty = { border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8 };

  /* one rail, one implementation: every Move cash — whether opened from the
     Branch Network, the Vault, or the Cash Drawer — goes through applyMove. */
  function applyMove(branches, moves, { kind, fromB, toB, tId, ccy, amt, fromLabel, toLabel }, by) {
    const adjV = (bb, d) => ({ ...bb, vault: { ...(bb.vault || {}), [ccy]: (((bb.vault || {})[ccy]) || 0) + d } });
    const adjT = (bb, tid, d) => ({ ...bb, tills: (bb.tills || []).map(t => t.id === tid ? { ...t, cash: { ...t.cash, [ccy]: ((t.cash && t.cash[ccy]) || 0) + d } } : t) });
    const nextBranches = branches.map(b => {
      let nb = b;
      if (kind === 'issue' && b.id === fromB) { nb = adjV(nb, -amt); nb = adjT(nb, tId, amt); }
      else if (kind === 'return' && b.id === fromB) { nb = adjT(nb, tId, -amt); nb = adjV(nb, amt); }
      else if (kind === 'vault') { if (b.id === fromB) nb = adjV(nb, -amt); if (b.id === toB) nb = adjV(nb, amt); }
      return nb;
    });
    const ref = 'MV-' + String(TODAY).slice(2).replace(/-/g, '') + '-' + (moves.filter(m => m.date === TODAY).length + 1).toString().padStart(2, '0');
    const move = { id: 'm' + Date.now(), ref, kind, from: fromLabel, to: toLabel, ccy, amount: amt, cadVal: +cadOf(amt, ccy).toFixed(2), date: TODAY, by };
    const verb = kind === 'issue' ? 'Float issued' : kind === 'return' ? 'Cash returned to vault' : 'Vault run';
    return { branches: nextBranches, moves: [move, ...moves], verb, detail: `${num(amt)} ${ccy} · ${fromLabel} → ${toLabel}` };
  }

  /* ===================== MOVE CASH — the vault rail =====================
     Three movements only, and each one debits one box and credits another:
       issue   vault → till   float a drawer from its branch vault
       return  till → vault   the day's cash goes back, tallied
       vault   vault → vault  an armoured run between branches (main → sub) */
  function MoveModal({ branches, station, preset, onClose, onMove }) {
    const KINDS = [
      ['issue',  'Issue float',   'vaultsafe', 'Vault → till · same branch'],
      ['return', 'Return to vault', 'wallet',  'Till → vault · same branch'],
      ['vault',  'Vault run',     'swap',      'Vault → vault · between branches'],
    ];
    const p = preset && typeof preset === 'object' ? preset : {};
    const mainB = branches.find(x => x.main) || branches[0];
    const [kind, setKind] = useState(p.kind || 'issue');
    const [bId, setBId] = useState(p.bId || (station && station.branchId) || (branches[0] || {}).id);
    const b = branches.find(x => x.id === bId) || branches[0];
    const tills = (b && b.tills) || [];
    const [tId, setTId] = useState(p.tId || (station && station.branchId === (p.bId || station.branchId) && station.tillId) || (tills[0] && tills[0].id));
    const till = tills.find(t => t.id === tId) || tills[0];
    const [toBId, setToBId] = useState(() => { const o = branches.find(x => x.id !== (p.bId || (station && station.branchId) || (mainB && mainB.id))); return o && o.id; });
    const toB = branches.find(x => x.id === toBId);
    const [ccy, setCcy] = useState('CAD');
    const [amount, setAmount] = useState('');
    const amt = +amount || 0;
    useEffect(() => { if (till && !tills.some(t => t.id === tId)) setTId(tills[0] && tills[0].id); }, [bId]);
    const avail = kind === 'return' ? ((till && till.cash && till.cash[ccy]) || 0) : vaultUnits(b || {}, ccy);
    const short = amt > avail;
    const sameV = kind === 'vault' && bId === toBId;
    const valid = amt > 0 && !short && (kind === 'vault' ? (!!toB && !sameV) : !!till);
    const vLab = (x) => x ? x.code + ' · Vault' : '';
    const tLab = (x, t) => (x && t) ? x.code + ' · ' + t.name.replace(/\s+—.*/, '') : '';
    const fromLabel = kind === 'return' ? tLab(b, till) : vLab(b);
    const toLabel = kind === 'issue' ? tLab(b, till) : kind === 'return' ? vLab(b) : vLab(toB);
    const submit = () => valid && onMove({ kind, fromB: bId, toB: toBId, tId: till && till.id, ccy, amt, fromLabel, toLabel });
    const toNow = kind === 'issue' ? ((till && till.cash && till.cash[ccy]) || 0) : kind === 'return' ? vaultUnits(b || {}, ccy) : vaultUnits(toB || {}, ccy);
    const Sel = ({ value, onChange, children, mono }) => (<select value={value} onChange={e => onChange(e.target.value)} onClick={e => e.stopPropagation()} className="w-full text-[12.5px] px-2 py-1.5 outline-none" style={{ border: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: 8, color: CD.ink, fontFamily: mono ? 'Space Mono, monospace' : 'inherit' }}>{children}</select>);
    const Static = ({ children }) => (<div className="w-full text-[12.5px] px-2 py-1.5" style={{ border: `1px solid ${CD.lineSoft}`, background: 'var(--cd-chip)', borderRadius: 8, color: CD.ink, fontWeight: 600 }}>{children}</div>);
    const Box = ({ tag, icon, iconBg, picker, now, after, bad }) => (
      <div className="flex-1 min-w-0 p-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 12, background: 'var(--cd-panel)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="grid place-items-center flex-none" style={{ width: 26, height: 26, borderRadius: 7, background: iconBg }}><Ic n={icon} s={14} c="var(--cd-on-ink)" /></span>
          <span className="text-[9px] font-bold px-1.5 py-0.5" style={{ background: 'var(--cd-chip)', color: CD.faint, borderRadius: 4, letterSpacing: '0.12em', fontFamily: 'Space Mono, monospace' }}>{tag}</span>
        </div>
        {picker}
        <div className="flex items-baseline justify-between mt-2.5"><span className="text-[9px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Holds now</span><span className="text-[11.5px]" style={{ fontFamily: 'Space Mono', color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{num(now)}</span></div>
        <div className="flex items-baseline justify-between mt-0.5"><span className="text-[9px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>After</span><span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: bad ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{num(after)}</span></div>
      </div>);
    const vaultTag = (x) => x && x.main ? 'MAIN VAULT' : 'SUB-VAULT';
    const vaultPickFrom = <Sel mono value={bId} onChange={setBId}>{branches.map(x => <option key={x.id} value={x.id}>{x.code} · {x.main ? 'Main vault' : 'Sub-vault'}</option>)}</Sel>;
    const vaultPickTo = <Sel mono value={toBId || ''} onChange={setToBId}>{branches.map(x => <option key={x.id} value={x.id}>{x.code} · {x.main ? 'Main vault' : 'Sub-vault'}</option>)}</Sel>;
    const tillPick = <Sel value={tId || ''} onChange={setTId}>{tills.map(t => <option key={t.id} value={t.id}>{t.name.replace(/\s+—.*/, '')}{t.operator ? ' · ' + t.operator : ''}</option>)}</Sel>;
    const vaultStatic = <Static>{b ? b.code + ' · Vault' : 'Vault'} <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--cd-brass-text, ' + CD.brass + ')', fontFamily: 'Space Mono, monospace' }}>{vaultTag(b)}</span></Static>;
    const fromBox = kind === 'issue' ? { tag: 'FROM · VAULT', icon: 'vaultsafe', iconBg: CD.brass, picker: vaultStatic }
      : kind === 'return' ? { tag: 'FROM · TILL', icon: 'wallet', iconBg: CD.ink, picker: tillPick }
      : { tag: 'FROM · VAULT', icon: 'vaultsafe', iconBg: CD.brass, picker: vaultPickFrom };
    const toBox = kind === 'issue' ? { tag: 'TO · TILL', icon: 'wallet', iconBg: CD.ink, picker: tillPick }
      : kind === 'return' ? { tag: 'TO · VAULT', icon: 'vaultsafe', iconBg: CD.brass, picker: vaultStatic }
      : { tag: 'TO · VAULT', icon: 'vaultsafe', iconBg: CD.brass, picker: vaultPickTo };
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 530, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="swap" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Move cash</div><div className="text-[11px]" style={{ color: CD.mute }}>One rail · every move debits one box and credits another</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4">
          {/* what kind of move */}
          <div className="grid grid-cols-3 gap-1.5 mb-3">
            {KINDS.map(([id, label, ic, sub]) => { const on = kind === id; return (
              <button key={id} onClick={() => setKind(id)} className="px-2.5 py-2 text-left" style={{ border: `1px solid ${on ? CD.ink : CD.line}`, background: on ? CD.ink : 'var(--cd-panel)', borderRadius: 10, cursor: 'pointer' }}>
                <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: on ? 'var(--cd-on-ink)' : CD.ink }}><Ic n={ic} s={13} c={on ? 'var(--cd-on-ink)' : CD.mute} />{label}</span>
                <span className="block text-[9px] mt-0.5" style={{ color: on ? 'var(--cd-on-ink)' : CD.faint, fontFamily: 'Space Mono, monospace', opacity: on ? 0.75 : 1, letterSpacing: '0.02em' }}>{sub}</span>
              </button>); })}
          </div>
          {/* where — branch context for same-branch moves */}
          {kind !== 'vault' && (<div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] uppercase tracking-widest flex-none" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>At branch</span>
            <div style={{ width: 240 }}><Sel mono value={bId} onChange={setBId}>{branches.map(x => <option key={x.id} value={x.id}>{x.code} · {x.name}{x.main ? ' · main' : ''}</option>)}</Sel></div>
          </div>)}
          {/* from → to, with balances before & after */}
          <div className="flex items-stretch gap-0 mb-3">
            <Box {...fromBox} now={avail} after={avail - amt} bad={short} />
            <div className="grid place-items-center flex-none" style={{ width: 40 }}><span className="grid place-items-center" style={{ width: 26, height: 26, borderRadius: 999, background: amt > 0 && !short && !sameV ? CD.ink : 'var(--cd-chip)' }}><Ic n="arrowright" s={14} c={amt > 0 && !short && !sameV ? 'var(--cd-on-ink)' : CD.faint} /></span></div>
            <Box {...toBox} now={toNow} after={toNow + amt} />
          </div>
          {/* how much */}
          <div className="flex items-center gap-2">
            <div style={{ width: 86 }}><Sel mono value={ccy} onChange={setCcy}>{BCCYS.map(c => <option key={c}>{c}</option>)}</Sel></div>
            <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0" className="flex-1 px-3 py-2 outline-none text-right" style={{ ...inputSty, borderColor: short ? CD.flag : CD.line, fontFamily: 'Space Mono', fontSize: 19, fontWeight: 700, color: CD.ink }} />
            {[['¼', 0.25], ['½', 0.5], ['Max', 1]].map(([l, f]) => (
              <button key={l} onClick={() => setAmount(String(Math.floor(avail * f)))} disabled={!avail} className="text-[11px] px-2.5 py-2 font-semibold flex-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: avail ? CD.mute : CD.faint, background: 'var(--cd-panel)', cursor: avail ? 'pointer' : 'not-allowed' }}>{l}</button>))}
          </div>
          {sameV && <div className="text-[11px] px-3 py-2 mt-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>Pick two different vaults.</div>}
          {short && <div className="text-[11px] px-3 py-2 mt-3" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>{kind === 'return' ? 'That till' : 'That vault'} only holds {num(avail)} {ccy} — it can't go negative.</div>}
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <span className="text-[11px] min-w-0 truncate" style={{ color: amt > 0 && !short && !sameV ? CD.mute : CD.faint, fontFamily: 'Space Mono, monospace' }}>{amt > 0 && !short && !sameV ? `${fromLabel} → ${toLabel} · ${fmt(cadOf(amt, ccy), 'CAD')}` : 'Recorded to History with your name on it'}</span>
          <div className="flex items-center gap-2 flex-none">
            <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
            <button onClick={submit} disabled={!valid} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: valid ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: valid ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> {kind === 'issue' ? 'Issue float' : kind === 'return' ? 'Return to vault' : 'Run cash'}</button>
          </div>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== ADD A LOCATION — the enterprise rail =====================
     The business model, made visible where it happens: every plan includes the
     Branch Network (one location, up to 10 tills). The moment an owner adds a
     second location the account is Enterprise — $699/mo per location. The new
     branch is born on the vault rail: a sub-vault funded from the main vault. */
  function AddBranchModal({ branches, employees, mainB, onClose, onCreate }) {
    const n = branches.length;
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [city, setCity] = useState('');
    const [managerId, setManagerId] = useState('');
    const [fund, setFund] = useState('');
    const autoCode = () => { const base = (name.trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2) || 'BR').toUpperCase(); return base + '-' + String(n + 1).padStart(2, '0'); };
    const effCode = (code.trim() || autoCode()).toUpperCase();
    const mainAvail = mainB ? (((mainB.vault || {}).CAD) || 0) : 0;
    const amt = +fund || 0;
    const short = amt > mainAvail;
    const valid = !!name.trim() && !short;
    const mgrs = (employees || []).filter(e => e.active !== false && e.role !== 'Owner');
    const newTotal = (n + 1) * LOCATION_FEE;
    const F = ({ label, hint, children }) => (<div><div className="text-[11px] mb-1 flex justify-between" style={{ color: CD.mute }}><span>{label}</span>{hint && <span style={{ color: CD.faint }}>{hint}</span>}</div>{children}</div>);
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9300 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 520, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="building" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Add a location</div><div className="text-[11px]" style={{ color: CD.mute }}>Enterprise · ${LOCATION_FEE}/mo per location · up to {TILL_CAP} tills each</div></div></div>
          <button onClick={onClose} className="p-1.5"><Ic n="x" s={18} c={CD.mute} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <F label="Location name"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Scarborough" className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty} autoFocus /></F>
            <F label="Branch code" hint="auto"><input value={code} onChange={e => setCode(e.target.value)} placeholder={autoCode()} className="w-full text-sm px-2.5 py-2 outline-none" style={{ ...inputSty, fontFamily: 'Space Mono' }} /></F>
          </div>
          <F label="Address / area"><input value={city} onChange={e => setCity(e.target.value)} placeholder="e.g. Toronto — Kennedy Rd" className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty} /></F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Branch manager" hint="optional"><select value={managerId} onChange={e => setManagerId(e.target.value)} className="w-full text-sm px-2.5 py-2 outline-none" style={inputSty}><option value="">Assign later — Team board</option>{mgrs.map(e => <option key={e.id} value={e.id}>{e.name} · {e.role}</option>)}</select></F>
            <F label="Opening float · CAD" hint={`main vault holds ${num(mainAvail)}`}><input value={fund} onChange={e => setFund(e.target.value)} inputMode="decimal" placeholder="0 — fund later" className="w-full text-sm px-2.5 py-2 outline-none text-right" style={{ ...inputSty, borderColor: short ? CD.flag : CD.line, fontFamily: 'Space Mono' }} /></F>
          </div>
          {short && <div className="text-[11px] px-3 py-2" style={{ background: CD.flagSoft, color: CD.flag, borderRadius: 8 }}>The main vault only holds {num(mainAvail)} CAD — run more cash in first.</div>}
          {amt > 0 && !short && <div className="flex items-center justify-between px-3 py-2" style={{ background: 'var(--cd-chip)', borderRadius: 8 }}><span className="text-[11.5px]" style={{ color: CD.mute }}>{mainB ? mainB.code : 'Main'} · Vault → {effCode} · Vault <span style={{ color: CD.faint }}>· vault run, day one</span></span><span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink }}>{num(amt)} CAD</span></div>}
          <div className="px-3.5 py-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 10, background: CD.panel }}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Plan · Enterprise</span>
              <span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{n + 1} × ${LOCATION_FEE} = ${num(newTotal)}/mo</span>
            </div>
            <div className="text-[10.5px] mt-1" style={{ color: CD.mute }}>Every plan includes the Branch Network — the base plan runs one location with up to {TILL_CAP} tills. Each additional location is ${LOCATION_FEE}/mo, billed to the business account; its staff, vault and tills appear everywhere the moment it's created.</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
          <button onClick={() => valid && onCreate({ name: name.trim(), code: effCode, city: city.trim() || '—', managerId, fund: amt })} disabled={!valid} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: valid ? CD.ink : 'var(--cd-disabled)', borderRadius: 8, cursor: valid ? 'pointer' : 'not-allowed' }}><Ic n="check" s={15} c="var(--cd-on-ink)" /> Add location · ${num(newTotal)}/mo</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== CONFIRM STATION SWITCH — deliberate, logged =====================
     Changing which drawer you operate is an accountability event: every surface
     that switches tills (header, Cash Drawer, Branch Network) confirms through
     this one modal, and the switch is stamped to the audit trail. */
  function ConfirmStationModal({ branch, till, me, onClose, onConfirm }) {
    const takeover = !!(till && till.operator && me && till.operator !== me.name);
    const brassText = 'var(--cd-brass-text, ' + CD.brass + ')';
    return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9400 }} onMouseDown={onClose}>
      <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 400, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
        <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
          <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, background: takeover ? CD.brassSoft : CD.ink, borderRadius: 8 }}><Ic n="wallet" s={15} c={takeover ? brassText : 'var(--cd-on-ink)'} /></span>
          <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>{takeover ? 'Take over this till?' : 'Switch to this till?'}</div><div className="text-[11px]" style={{ color: CD.mute }}>{branch ? branch.name : ''} · {till ? till.name : ''}</div></div>
        </div>
        <div className="px-5 py-4">
          {takeover && <div className="text-[11.5px] px-3 py-2.5 mb-3" style={{ background: CD.brassSoft, color: brassText, borderRadius: 9 }}><b>{till.operator}</b> is on this drawer right now — taking over ends their session and is recorded as a handover.</div>}
          <p className="text-[12px] m-0" style={{ color: CD.mute, lineHeight: 1.55 }}>Your session moves to this drawer — the header, Cash Drawer and cash rail all follow, and the switch is stamped to the audit trail with your name and the time.</p>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
          <button onClick={onClose} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Cancel</button>
          <button onClick={onConfirm} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: takeover ? CD.brass : CD.ink, borderRadius: 8 }}><Ic n="check" s={14} c="var(--cd-on-ink)" /> {takeover ? 'Take over till' : 'Switch till'}</button>
        </div>
      </div>
    </div></Portal>);
  }

  /* ===================== FX-MIX STACK ===================== */
  function MixBar({ b, h = 10 }) {
    const total = branchCad(b) || 1;
    const segs = BCCYS.map(c => ({ c, v: cadOf(branchUnits(b, c), c) })).filter(s => s.v > 0).sort((a, z) => z.v - a.v);
    return (<div className="flex w-full overflow-hidden" style={{ height: h, borderRadius: 999, background: CD.lineSoft }}>
      {segs.map(s => <div key={s.c} title={`${s.c} · ${Math.round(s.v / total * 100)}%`} style={{ width: (s.v / total * 100) + '%', background: TONE[s.c] || CD.faint }}></div>)}
    </div>);
  }

  /* ===================== TEAM BOARD — drag people onto branches & tills =====================
     The assignment surface (spec rules R1–R7), shared by Branch Network → Team
     and Settings → Employees. Drag an employee onto a branch to say they MAY
     work there; drop them on a specific till to POST them to it (their default
     drawer at sign-in). Who's operating right now is a live session — shown
     here, but set by sign-ins, never by drag. */
  const initialsOf = (name) => String(name || '').split(/[ .]+/).filter(Boolean).map(x => x[0]).join('').slice(0, 2).toUpperCase();
  function TeamBoard({ me, log, branches, setBranches, settings, setSettings }) {
    const [drag, setDrag] = useState(null);   // { id, src } — src = branch the chip left from (null = pool)
    const [over, setOver] = useState(null);   // 'b01' | 'b01/b01t1' | 'pool'
    const roster = (settings && Array.isArray(settings.employees) ? settings.employees : []).filter(e => e.active !== false);
    const setEmps = (fn) => setSettings && setSettings(s => ({ ...s, employees: fn(s.employees || []) }));
    const isNet = (e) => e.role === 'Owner' || e.branches === '*';
    const scopeOf = (e) => isNet(e) ? 'network' : ((ROLE_SCOPE && ROLE_SCOPE[e.role]) || 'till');
    const meRec = roster.find(x => x.name === me.name);
    const canEdit = (bId) => me.role === 'Owner' || (me.role === 'Manager' && meRec && (meRec.branches === '*' || (Array.isArray(meRec.branches) && meRec.branches.includes(bId))));
    const asgOf = (e) => Array.isArray(e.branches) ? e.branches : [];
    const codeOf = (bId) => (branches.find(b => b.id === bId) || {}).code || bId;
    const postOf = (name) => { for (const b of branches) for (const t of (b.tills || [])) if (t.teller === name) return { bId: b.id, tId: t.id, b, t }; return null; };
    const setPost = (name, bId, tId) => setBranches(list => list.map(b => ({ ...b, tills: (b.tills || []).map(t => { let teller = t.teller === name ? '' : t.teller; if (b.id === bId && t.id === tId) teller = name; return teller === t.teller ? t : { ...t, teller }; }) })));
    const assign = (e, bId) => {
      if (!canEdit(bId) || isNet(e)) return false;
      const cur = asgOf(e);
      if (!cur.includes(bId)) { setEmps(list => list.map(x => x.id === e.id ? { ...x, branches: [...cur, bId], home: x.home || bId } : x)); log && log('Branch assigned', `${e.name} + ${codeOf(bId)}`); }
      return true;
    };
    const unassign = (e, bId) => {
      if (!canEdit(bId) || isNet(e)) return;
      const next = asgOf(e).filter(x => x !== bId);
      setEmps(list => list.map(x => x.id === e.id ? { ...x, branches: next, home: x.home === bId ? (next[0] || null) : x.home } : x));
      // leaving a branch releases their posted till AND any live session there
      setBranches(list => list.map(b => b.id !== bId ? b : { ...b, tills: (b.tills || []).map(t => (t.teller === e.name || t.operator === e.name) ? { ...t, teller: t.teller === e.name ? '' : t.teller, operator: t.operator === e.name ? '' : t.operator } : t) }));
      log && log('Branch assignment removed', `${e.name} − ${codeOf(bId)}`);
    };
    const setHome = (e, bId) => { if (e.home === bId || !canEdit(bId)) return; setEmps(list => list.map(x => x.id === e.id ? { ...x, home: bId } : x)); log && log('Home branch set', `${e.name} → ${codeOf(bId)}`); };
    const dragEmp = drag && roster.find(e => e.id === drag.id);
    const droppable = (bId) => !!(dragEmp && !isNet(dragEmp) && canEdit(bId));
    const startDrag = (ev, emp, src) => { try { ev.dataTransfer.setData('text/plain', emp.id); ev.dataTransfer.effectAllowed = 'move'; } catch (x) {} setDrag({ id: emp.id, src: src || null }); };
    const endDrag = () => { setDrag(null); setOver(null); };
    const hover = (ev, key, ok) => { if (!ok) return; ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key); };
    const leave = (ev, key) => { if (!ev.currentTarget.contains(ev.relatedTarget)) setOver(o => o === key ? null : o); };
    const dropOn = (ev, bId, tId) => {
      ev.preventDefault(); ev.stopPropagation();
      const emp = dragEmp; endDrag();
      if (!emp || isNet(emp) || !canEdit(bId)) return;
      if (assign(emp, bId) && tId) { const b = branches.find(x => x.id === bId); const t = b && (b.tills || []).find(x => x.id === tId); if (t && t.teller !== emp.name) { setPost(emp.name, bId, tId); log && log('Teller posted', `${emp.name} → ${(t.name || '').replace(/\s+—.*/, '')} · ${b.code}`); } }
    };
    const dropPool = (ev) => { ev.preventDefault(); const emp = dragEmp; const src = drag && drag.src; endDrag(); if (emp && src) unassign(emp, src); };
    const scopeSty = (s) => s === 'network' ? { background: CD.ink, color: 'var(--cd-on-ink)' } : s === 'branch' ? { background: CD.brassSoft, color: 'var(--cd-brass-text, ' + CD.brass + ')' } : { background: 'var(--cd-chip)', color: CD.mute };
    const Ava = ({ name, s = 24, dim }) => <span className="grid place-items-center flex-none" style={{ width: s, height: s, borderRadius: '50%', background: dim ? 'var(--cd-chip)' : CD.ink, color: dim ? CD.mute : 'var(--cd-on-ink)', fontSize: s * 0.34, fontWeight: 700, fontFamily: 'Space Mono, monospace' }}>{initialsOf(name)}</span>;

    return (<div>
      {/* ---- the bench: everyone, draggable ---- */}
      <div onDragOver={ev => hover(ev, 'pool', !!(drag && drag.src))} onDragLeave={ev => leave(ev, 'pool')} onDrop={dropPool}
        className="p-3 mb-3" style={{ background: CD.panel, border: `1.5px ${over === 'pool' ? 'dashed' : 'solid'} ${over === 'pool' ? CD.flag : CD.line}`, borderRadius: 12 }}>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Team · {roster.length}</span>
          <span className="text-[10.5px]" style={{ color: over === 'pool' ? CD.flag : CD.faint }}>{over === 'pool' ? `Drop to take ${dragEmp ? dragEmp.name : ''} off ${codeOf(drag.src)}` : 'Drag someone onto a branch to assign them — onto a till to post them to that drawer'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {roster.map(e => {
            const net = isNet(e); const asg = asgOf(e); const un = !net && !asg.length; const ghost = drag && drag.id === e.id;
            return (<div key={e.id || e.name} draggable={!net} onDragStart={ev => startDrag(ev, e, null)} onDragEnd={endDrag}
              title={net ? 'Owners cover the whole network — nothing to assign' : 'Drag onto a branch or till'}
              className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5" style={{ border: `1px solid ${un ? CD.flag : CD.line}`, borderRadius: 999, background: 'var(--cd-paper-soft, var(--cd-chip))', cursor: net ? 'default' : 'grab', opacity: ghost ? 0.35 : 1 }}>
              <Ava name={e.name} />
              <span>
                <span className="block text-[12px] font-semibold leading-tight" style={{ color: CD.ink }}>{e.name}</span>
                <span className="block text-[9.5px] leading-tight" style={{ color: un ? CD.flag : CD.faint, fontFamily: 'Space Mono, monospace' }}>{net ? 'owner · everywhere' : un ? 'not assigned — can’t sign in' : e.role.toLowerCase() + ' · ' + asg.map(codeOf).join(' ')}</span>
              </span>
            </div>);
          })}
        </div>
      </div>

      {/* ---- branch cards: drop targets ---- */}
      <div className="grid sm:grid-cols-2 gap-2.5">
        {branches.map(b => {
          const staff = roster.filter(e => asgOf(e).includes(b.id));
          const editable = canEdit(b.id);
          const hot = over === b.id && droppable(b.id);
          return (<div key={b.id} onDragOver={ev => hover(ev, b.id, droppable(b.id))} onDragLeave={ev => leave(ev, b.id)} onDrop={ev => dropOn(ev, b.id, null)}
            style={{ background: CD.panel, border: `1.5px ${hot ? 'dashed' : 'solid'} ${hot ? CD.brass : CD.line}`, borderRadius: 12, boxShadow: hot ? `0 0 0 3px ${CD.brassSoft}` : 'none', opacity: b.status === 'closed' ? 0.8 : 1, transition: 'box-shadow 120ms, border-color 120ms' }}>
            <div className="flex items-center gap-2.5 px-3 py-2.5" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
              <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: hot ? CD.brass : CD.ink }}><Ic n="building" s={15} c="var(--cd-on-ink)" /></span>
              <div className="flex-1 min-w-0"><div className="text-[13px] font-semibold" style={{ color: CD.ink }}>{b.name} <span className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {b.code}</span></div><div className="text-[10.5px]" style={{ color: CD.mute }}>{staff.length ? staff.length + ' assigned' : 'nobody assigned'} · {(b.tills || []).length} till{(b.tills || []).length === 1 ? '' : 's'}</div></div>
              {!editable && <span title="Managers assign within their own branch (R7)" className="flex items-center"><Ic n="lock" s={12} c={CD.faint} /></span>}
            </div>
            <div className="px-3 pt-2.5 pb-1" style={{ minHeight: 44 }}>
              {staff.length ? (<div className="flex flex-wrap gap-1.5">
                {staff.map(e => { const home = e.home === b.id; const ghost = drag && drag.id === e.id && drag.src === b.id; return (
                  <span key={e.id || e.name} draggable={editable} onDragStart={ev => startDrag(ev, e, b.id)} onDragEnd={endDrag}
                    className="flex items-center gap-1.5 pl-1 pr-1.5 py-1" style={{ border: `1px solid ${CD.line}`, borderRadius: 999, background: 'var(--cd-paper-soft, var(--cd-chip))', cursor: editable ? 'grab' : 'default', opacity: ghost ? 0.35 : 1 }}>
                    <Ava name={e.name} s={20} />
                    <span className="text-[11.5px] font-medium" style={{ color: CD.ink }}>{e.name}</span>
                    <button onClick={() => setHome(e, b.id)} title={home ? 'Home branch — where they land at sign-in' : 'Make this their home branch'} disabled={!editable}
                      style={{ border: 0, background: 'transparent', padding: 0, cursor: editable ? 'pointer' : 'default', fontSize: 11, lineHeight: 1, color: home ? CD.brass : CD.lineSoft }}>★</button>
                    {editable && <button onClick={() => unassign(e, b.id)} title={'Remove from ' + b.code} style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex' }}><Ic n="x" s={11} c={CD.faint} /></button>}
                  </span>); })}
              </div>) : (<div className="text-[11px] px-2 py-2 text-center" style={{ color: CD.faint, border: `1px dashed ${CD.line}`, borderRadius: 8 }}>{editable ? 'Drag someone here' : 'Nobody assigned'}</div>)}
            </div>
            <div className="px-3 pb-2.5 pt-1.5">
              {(b.tills || []).map(t => {
                const key = b.id + '/' + t.id; const tHot = over === key && droppable(b.id);
                return (<div key={t.id} onDragOver={ev => hover(ev, key, droppable(b.id))} onDragLeave={ev => leave(ev, key)} onDrop={ev => dropOn(ev, b.id, t.id)}
                  className="flex items-center gap-2 px-2 py-1.5 mb-1" style={{ border: `1px ${tHot ? 'dashed' : 'solid'} ${tHot ? CD.brass : CD.lineSoft}`, borderRadius: 8, background: tHot ? CD.brassSoft : 'transparent', transition: 'background 120ms' }}>
                  <Ic n="wallet" s={12} c={t.status === 'closed' ? CD.faint : CD.mute} />
                  <span className="text-[11px] font-medium flex-none" style={{ color: t.status === 'closed' ? CD.faint : CD.ink }}>{t.name.replace(/\s+—.*/, '')}</span>
                  <span className="text-[10px] flex-1 truncate" style={{ color: tHot ? 'var(--cd-brass-text, ' + CD.brass + ')' : CD.faint, fontFamily: 'Space Mono, monospace' }}>{tHot ? 'post ' + (dragEmp ? dragEmp.name : '') + ' here' : (t.teller ? 'posted · ' + t.teller : 'no one posted')}</span>
                  <span className="flex items-center gap-1 flex-none text-[10px]" style={{ color: t.operator ? CD.green : CD.faint }}><span style={{ width: 5, height: 5, borderRadius: 999, background: t.operator ? CD.green : CD.lineSoft, display: 'inline-block' }}></span>{t.operator ? (t.operator === me.name ? 'you · on now' : t.operator + ' · on now') : 'free'}</span>
                </div>);
              })}
            </div>
          </div>);
        })}
      </div>
      <p className="mt-3 text-[11px]" style={{ color: CD.faint, maxWidth: 660 }}>★ marks the <b>home branch</b> — where they land at sign-in. Posting someone to a till makes it their default drawer: one branch + a posted till means they skip every picker. Who's <b>on</b> a till right now is a session — it follows sign-ins and frees itself at sign-out. Owners edit everything; managers arrange their own branch.</p>
    </div>);
  }

  /* ===================== MAIN ===================== */
  function Branches({ me, log, branches, setBranches, moves, setMoves, station, setStation, settings, setSettings, onOpenTill, gate }) {
    const [tab, setTab] = useState('network');
    const [moving, setMoving] = useState(null);
    const [histScope, setHistScope] = useState('all');
    const [vaultOpen, setVaultOpen] = useState(null);   // branch id whose vault panel is expanded

    const netCash = branches.reduce((s, b) => s + branchCad(b), 0);
    const netVault = branches.reduce((s, b) => s + vaultCad(b), 0);
    const netTills = branches.reduce((s, b) => s + tillsCad(b), 0);
    const mainB = branches.find(b => b.main) || branches[0];
    // vault operation is branch-scope work: owners & managers/seniors run the rail;
    // till-scope roles (cashier/trainee) see it but ask their manager (R5)
    const canRail = me.role === 'Owner' || ((ROLE_SCOPE || {})[me.role] || 'till') === 'branch';
    const netVol = branches.reduce((s, b) => s + (b.volToday || 0), 0);
    const netDeals = branches.reduce((s, b) => s + (b.dealsToday || 0), 0);
    const openN = branches.filter(b => b.status === 'open').length;
    const tillsOpen = branches.reduce((s, b) => s + (b.status === 'open' ? (b.tills || []).filter(t => t.status === 'open').length : 0), 0);
    const activeBranch = branches.find(b => b.id === (station && station.branchId));
    const activeTill = activeBranch && (activeBranch.tills || []).find(t => t.id === station.tillId);

    /* the vault rail — every movement debits one box and credits another */
    const doMove = (payload) => {
      const r = applyMove(branches, moves, payload, me.name);
      setBranches(r.branches); setMoves(r.moves);
      log && log(r.verb, r.detail);
      setMoving(null);
    };
    const toggleBranch = (id) => setBranches(list => list.map(b => b.id === id ? { ...b, status: b.status === 'open' ? 'closed' : 'open' } : b));
    const toggleTill = (bId, tId) => setBranches(list => list.map(b => b.id === bId ? { ...b, tills: b.tills.map(t => t.id === tId ? { ...t, status: t.status === 'open' ? 'closed' : 'open' } : t) } : b));
    const addTill = (bId) => setBranches(list => list.map(b => {
      if (b.id !== bId) return b;
      if ((b.tills || []).length >= TILL_CAP) return b;   // every location caps at 10 tills
      const n = (b.tills || []).length + 1;
      return { ...b, tills: [...b.tills, { id: b.id + 't' + Date.now(), name: 'Till ' + n, teller: '', operator: '', status: 'open', cash: { CAD: 0 } }] };
    }));
    /* Adding a location now lives in Settings → Locations (enterprise modal,
       exported below as AddBranchModal) — the network app only operates it. */
    const [confirmDel, setConfirmDel] = useState(null);   // { bId, tId } pending till deletion
    const [pendingSt, setPendingSt] = useState(null);     // { bId, tId } pending station switch (confirmed via modal)
    const deleteTill = (bId, tId) => {
      const b = branches.find(x => x.id === bId); const t = b && (b.tills || []).find(x => x.id === tId);
      if (!b || !t || tillCad(t) > 0) return;   // a drawer holding cash can never be deleted — return it first
      setBranches(list => list.map(x => x.id !== bId ? x : { ...x, tills: (x.tills || []).filter(y => y.id !== tId) }));
      log && log('Till removed', `${b.code} · ${t.name} — empty, deleted`);
      setConfirmDel(null);
    };
    const makeActive = (bId, tId) => setPendingSt({ bId, tId });
    const doSwitch = (bId, tId) => {
      const b = branches.find(x => x.id === bId); const t = ((b && b.tills) || []).find(x => x.id === tId) || {};
      (gate || ((fn) => fn()))(() => {
        if (t.operator && t.operator !== me.name) log && log('Till handover', `${t.operator} → ${me.name} · ${b.code} ${t.name}`);
        setStation && setStation({ branchId: bId, tillId: tId });
        log && log('Station switched', b.code + ' · ' + (t.name || ''));
        setPendingSt(null);
      });
    };

    const TABS = [['network', 'Network', 'building'], ['tills', 'Branches & tills', 'wallet'], ['team', 'Team', 'users'], ['movements', 'History', 'clock']];

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      <div className="px-4 pt-3 flex-none" style={{ background: CD.panel }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5"><span className="grid place-items-center" style={{ width: 30, height: 30, background: '#fff', boxShadow: 'inset 0 0 0 1px ' + CD.line, borderRadius: 8 }}><Ic n="branchnet" s={16} c="var(--cd-on-ink)" /></span><div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Branch Network</div><div className="text-[11px]" style={{ color: CD.mute }}>{openN} of {branches.length} branches open · {tillsOpen} tills live · {fmt(netCash, 'CAD')} network cash</div></div></div>
          <div className="flex items-center gap-2">
            {canRail && <button onClick={() => setMoving({})} className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="swap" s={15} c="var(--cd-on-ink)" /> Move cash</button>}
          </div>
        </div>
        {activeBranch && activeTill && <div className="flex items-center gap-2 pt-2 text-[11px]" style={{ color: CD.mute }}><span className="grid place-items-center" style={{ width: 6, height: 6, borderRadius: 999, background: CD.green }}></span>You're operating <b style={{ color: CD.ink }}>{activeBranch.name}</b> · {activeTill.name}</div>}
        <div className="fld-bar" style={{ '--ft': '#17140F', margin: '2px -16px 0', padding: '0 16px' }}>{TABS.map(([id, label, ic]) => (
          <button key={id} onClick={() => setTab(id)} className={'fld-tab' + (tab === id ? ' on' : '')}><Ic n={ic} s={13} c={tab === id ? 'var(--cd-on-ink)' : CD.mute} /> {label}</button>))}</div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* ===================== NETWORK — consolidated cash position & FX mix ===================== */}
        {tab === 'network' && (<div>
          <div className="grid grid-cols-5 gap-2 mb-3">
            {[['Network cash · CAD', fmt(netCash, 'CAD')], ['In vaults', fmt(netVault, 'CAD')], ['In tills', fmt(netTills, 'CAD')], ['Branches open', `${openN} / ${branches.length}`], ['Volume today', fmt(netVol, 'CAD')]].map(([l, v]) => (
              <div key={l} className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 11 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-xl font-bold" style={{ color: CD.ink, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
          </div>

          {/* consolidated cash position: currency × branch matrix */}
          <div className="overflow-hidden mb-4" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
            <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.line}` }}><span className="text-[12px] font-semibold" style={{ color: CD.ink }}>Consolidated cash position</span><span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>units held · CAD value</span></div>
            <table className="w-full text-sm border-collapse">
              <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">
                <th className="px-3 py-2">Currency</th>
                {branches.map(b => <th key={b.id} className="px-2 py-2 text-right" style={{ color: b.id === (station && station.branchId) ? CD.ink : CD.mute }}>{b.code}</th>)}
                <th className="px-3 py-2 text-right" style={{ color: CD.ink }}>Network</th>
                <th className="px-3 py-2 text-right">CAD value</th>
                <th className="px-3 py-2 text-right">Mix</th>
              </tr></thead>
              <tbody>{BCCYS.map(c => {
                const netUnits = branches.reduce((s, b) => s + branchUnits(b, c), 0);
                const cad = cadOf(netUnits, c);
                const mix = netCash ? cad / netCash * 100 : 0;
                if (netUnits <= 0) return null;
                return (<tr key={c} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                  <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(c)}</span> {c}</td>
                  {branches.map(b => <td key={b.id} className="px-2 py-2 text-right" style={{ fontFamily: 'Space Mono', fontSize: 11.5, fontVariantNumeric: 'tabular-nums', color: branchUnits(b, c) ? CD.mute : CD.faint }}>{branchUnits(b, c) ? num(branchUnits(b, c)) : '—'}</td>)}
                  <td className="px-3 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(netUnits)}</td>
                  <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(cad, 'CAD')}</td>
                  <td className="px-3 py-2 text-right"><div className="flex items-center justify-end gap-2"><span className="text-[10.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono', width: 32, textAlign: 'right' }}>{mix.toFixed(0)}%</span><span style={{ width: 44, height: 7, borderRadius: 999, background: CD.lineSoft, overflow: 'hidden', display: 'inline-block' }}><span style={{ display: 'block', height: '100%', width: mix + '%', background: TONE[c] || CD.faint }}></span></span></div></td>
                </tr>); })}
              </tbody>
              <tfoot><tr style={{ borderTop: `2px solid ${CD.line}`, background: 'var(--cd-chip)' }}>
                <td className="px-3 py-2 font-semibold" style={{ color: CD.ink }}>Total · CAD</td>
                {branches.map(b => <td key={b.id} className="px-2 py-2 text-right font-semibold" style={{ fontFamily: 'Space Mono', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{Math.round(branchCad(b) / 1000)}k</td>)}
                <td className="px-3 py-2 text-right font-bold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }} colSpan={2}>{fmt(netCash, 'CAD')}</td>
                <td></td>
              </tr></tfoot>
            </table>
          </div>

          {/* FX mix by branch */}
          <div className="text-[12px] font-semibold mb-2" style={{ color: CD.ink }}>FX mix by branch</div>
          <div className="grid sm:grid-cols-2 gap-2.5 mb-2">
            {branches.map(b => { const cash = branchCad(b); const closed = b.status === 'closed'; const fx = BCCYS.filter(c => c !== 'CAD').reduce((s, c) => s + cadOf(branchUnits(b, c), c), 0); return (
              <div key={b.id} className="p-3.5" style={{ background: CD.panel, border: `1px solid ${b.id === (station && station.branchId) ? CD.ink : CD.line}`, borderRadius: 12, opacity: closed ? 0.72 : 1 }}>
                <div className="flex items-start justify-between mb-2.5">
                  <div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {b.code}</span>{b.main && <span className="text-[8.5px] px-1.5 py-0.5 ml-1.5 font-bold align-middle" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 4, letterSpacing: '0.06em' }}>MAIN</span>}</div><div className="text-[11px]" style={{ color: CD.mute }}>vault {fmt(vaultCad(b), 'CAD')} · tills {fmt(tillsCad(b), 'CAD')} · {cash ? Math.round(fx / cash * 100) : 0}% in FX</div></div>
                  <button onClick={() => toggleBranch(b.id)} className="text-[10px] px-2 py-0.5 font-semibold" style={{ background: closed ? CD.lineSoft : CD.greenSoft, color: closed ? CD.mute : CD.green, borderRadius: 999 }}>{closed ? 'CLOSED' : 'OPEN'}</button>
                </div>
                <MixBar b={b} />
                <div className="mt-2.5 flex flex-wrap gap-1.5">{BCCYS.filter(c => branchUnits(b, c) > 0).map(c => <span key={c} className="flex items-center gap-1 text-[10.5px]" style={{ color: CD.mute }}><span style={{ width: 8, height: 8, borderRadius: 2, background: TONE[c] || CD.faint, display: 'inline-block' }}></span>{c}</span>)}</div>
              </div>); })}
          </div>
          <p className="mt-1 text-[11px]" style={{ color: CD.faint }}>Cash rests in each branch's <b>vault</b>; tills only borrow from it. The main vault at {mainB ? mainB.code : 'the main branch'} funds every sub-vault — a branch is vault + tills, the network the sum of its branches. This rollup is what head-office reconciles against.</p>
        </div>)}

        {/* ===================== BRANCHES & TILLS ===================== */}
        {tab === 'tills' && (<div className="space-y-3">
          {branches.map(b => { const closed = b.status === 'closed'; return (
            <div key={b.id} style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 12, opacity: closed ? 0.78 : 1 }}>
              <div className="flex items-center justify-between px-3.5 py-3" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}>
                <div className="flex items-center gap-2.5">
                  <span className="grid place-items-center flex-none" style={{ width: 34, height: 34, borderRadius: 9, background: CD.ink }}><Ic n="building" s={17} c="var(--cd-on-ink)" /></span>
                  <div><div className="text-[14px] font-semibold" style={{ color: CD.ink }}>{b.name} <span className="text-[11px]" style={{ color: CD.faint, fontFamily: 'Space Mono' }}>· {b.code}</span></div><div className="text-[11px]" style={{ color: CD.mute }}>{b.city} · {fmt(branchCad(b), 'CAD')}</div></div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => addTill(b.id)} disabled={(b.tills || []).length >= TILL_CAP} title={(b.tills || []).length >= TILL_CAP ? `Every location runs up to ${TILL_CAP} tills` : 'Add a till at this location'} className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: (b.tills || []).length >= TILL_CAP ? CD.faint : CD.mute, cursor: (b.tills || []).length >= TILL_CAP ? 'not-allowed' : 'pointer' }}><Ic n="plus" s={12} c={CD.mute} /> Add till <span style={{ fontFamily: 'Space Mono, monospace', fontSize: 9.5, color: CD.faint }}>{(b.tills || []).length}/{TILL_CAP}</span></button>
                  <button onClick={() => toggleBranch(b.id)} className="text-[10px] px-2 py-1 font-semibold" style={{ background: closed ? CD.lineSoft : CD.greenSoft, color: closed ? CD.mute : CD.green, borderRadius: 999 }}>{closed ? 'CLOSED' : 'OPEN'}</button>
                </div>
              </div>
              {/* the branch vault — where this location's cash rests. Click to open:
                 per-currency holdings + what came in / went out on the rail today. */}
              {(() => {
                const vLabel = b.code + ' · Vault';
                const open = vaultOpen === b.id;
                const vMoves = moves.filter(m => m.from === vLabel || m.to === vLabel);
                const today = vMoves.filter(m => m.date === TODAY);
                const sumIf = (f) => today.filter(f).reduce((s, m) => s + (m.cadVal || 0), 0);
                const issued = sumIf(m => m.kind === 'issue' && m.from === vLabel);
                const returned = sumIf(m => m.kind === 'return' && m.to === vLabel);
                const runIn = sumIf(m => m.kind === 'vault' && m.to === vLabel);
                const runOut = sumIf(m => m.kind === 'vault' && m.from === vLabel);
                const net = returned + runIn - issued - runOut;
                const recent = vMoves.slice(0, 5);
                const held = BCCYS.filter(c => vaultUnits(b, c) > 0);
                return (<div style={{ borderBottom: `1px solid ${CD.lineSoft}`, background: 'var(--cd-chip)' }}>
                  <div onClick={() => setVaultOpen(open ? null : b.id)} className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left" style={{ cursor: 'pointer' }} title={open ? 'Collapse vault' : 'Open vault — holdings & today’s movements'}>
                    <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: CD.brass }}><Ic n="vaultsafe" s={15} c="var(--cd-on-ink)" /></span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold flex items-center gap-2" style={{ color: CD.ink }}>Vault<span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ background: b.main ? CD.ink : CD.brassSoft, color: b.main ? 'var(--cd-on-ink)' : 'var(--cd-brass-text, ' + CD.brass + ')', borderRadius: 4, letterSpacing: '0.06em' }}>{b.main ? 'MAIN VAULT' : 'SUB-VAULT'}</span></div>
                      <div className="text-[10.5px]" style={{ color: CD.mute }}>{today.length ? `today · issued ${fmt(issued, 'CAD')} · back ${fmt(returned + runIn, 'CAD')} · net ${net >= 0 ? '+' : ''}${fmt(net, 'CAD')}` : (b.main ? 'The network’s cash root — funds every sub-vault · no movements today' : `Funded from ${mainB ? mainB.code : 'the main vault'} · no movements today`)}</div>
                    </div>
                    <div className="text-right flex-none" style={{ width: 110 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Vault · CAD</div><div className="text-[13.5px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }}>{fmt(vaultCad(b), 'CAD')}</div></div>
                    <div className="flex items-center gap-1.5 flex-none" onClick={e => e.stopPropagation()}>
                      {canRail && <button onClick={() => setMoving({ kind: 'issue', bId: b.id })} title="Float a till from this vault" className="text-[11px] px-2.5 py-1.5 font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-panel)' }}>Issue float</button>}
                      {canRail && <button onClick={() => setMoving({ kind: 'return', bId: b.id })} title="Return till cash to this vault" className="text-[11px] px-2.5 py-1.5 font-semibold" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, color: CD.ink, background: 'var(--cd-panel)' }}>Return</button>}
                    </div>
                    <span className="flex-none" style={{ display: 'inline-flex', transform: open ? 'rotate(-90deg)' : 'rotate(90deg)', transition: 'transform 140ms' }}><Ic n="chev" s={13} c={CD.faint} /></span>
                  </div>
                  {open && (<div className="grid sm:grid-cols-2 gap-3 px-3.5 pb-3.5">
                    <div style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.lineSoft}`, borderRadius: 10, overflow: 'hidden' }}>
                      <div className="px-3 py-2 text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace', borderBottom: `1px solid ${CD.lineSoft}` }}>In the vault</div>
                      {held.length ? held.map(c => { const u = vaultUnits(b, c); return (
                        <div key={c} className="flex items-center gap-2 px-3 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                          <span className="text-[12px] font-medium flex-none" style={{ color: CD.ink, width: 52 }}><span style={{ fontFamily: 'system-ui' }}>{flagOf(c)}</span> {c}</span>
                          <span className="flex-1 text-right text-[12px]" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(u)}</span>
                          <span className="flex-none text-right text-[10.5px]" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.faint, width: 90 }}>{fmt(cadOf(u, c), 'CAD')}</span>
                        </div>); }) : <div className="px-3 py-4 text-center text-[11px]" style={{ color: CD.faint }}>Empty — fund it with a vault run.</div>}
                    </div>
                    <div style={{ background: 'var(--cd-panel)', border: `1px solid ${CD.lineSoft}`, borderRadius: 10, overflow: 'hidden' }}>
                      <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${CD.lineSoft}` }}><span className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>On the rail · recent</span><button onClick={() => setTab('movements')} className="text-[10px]" style={{ color: CD.mute, border: 0, background: 'transparent', cursor: 'pointer' }}>all movements ›</button></div>
                      {recent.length ? recent.map(m => { const out = m.from === vLabel; const other = out ? m.to : m.from; return (
                        <div key={m.id} className="flex items-center gap-2 px-3 py-1.5" style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                          <span className="grid place-items-center flex-none" style={{ width: 18, height: 18, borderRadius: 5, background: out ? CD.lineSoft : CD.greenSoft }}><Ic n={out ? 'arrowup' : 'arrowdown'} s={11} c={out ? CD.mute : CD.green} /></span>
                          <span className="flex-1 min-w-0 truncate text-[11.5px]" style={{ color: CD.ink }}>{out ? '→ ' : '← '}{other}<span className="text-[9.5px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}> · {m.date === TODAY ? 'today' : m.date} · {m.by}</span></span>
                          <span className="flex-none text-[11.5px] font-semibold" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: out ? CD.mute : CD.green }}>{out ? '−' : '+'}{num(m.amount)} {m.ccy}</span>
                        </div>); }) : <div className="px-3 py-4 text-center text-[11px]" style={{ color: CD.faint }}>Nothing yet today — <b>Issue float</b> at open, <b>Return</b> at close.</div>}
                    </div>
                  </div>)}
                </div>);
              })()}
              <div className="divide-y" style={{ borderColor: CD.lineSoft }}>
                {(b.tills || []).map(t => { const isActive = station && station.branchId === b.id && station.tillId === t.id; const tClosed = t.status === 'closed'; const occupied = t.operator && t.operator !== me.name; return (
                  <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5" style={{ borderTop: `1px solid ${CD.lineSoft}`, background: isActive ? CD.brassSoft : 'transparent' }}>
                    <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, borderRadius: 8, background: isActive ? CD.ink : 'var(--cd-chip)' }}><Ic n="wallet" s={15} c={isActive ? 'var(--cd-on-ink)' : CD.mute} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium flex items-center gap-2" style={{ color: CD.ink }}>{t.name}{isActive && <span className="text-[8.5px] px-1.5 py-0.5 font-bold" style={{ background: CD.ink, color: 'var(--cd-on-ink)', borderRadius: 4, letterSpacing: '0.06em' }}>OPERATING</span>}</div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px]">
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: t.operator ? CD.green : CD.lineSoft, display: 'inline-block', flex: 'none' }}></span>
                        {t.operator
                          ? <span style={{ color: CD.ink, fontWeight: 600 }}>{t.operator === me.name ? 'You' : t.operator} <span style={{ color: CD.mute, fontWeight: 400 }}>· on this till now</span></span>
                          : <span style={{ color: CD.faint }}>Free{tClosed ? ' · closed' : ''}</span>}
                        {t.teller && t.teller !== t.operator && <span style={{ color: CD.faint }}>· posted to {t.teller}</span>}
                      </div>
                    </div>
                    <div className="text-right flex-none" style={{ width: 110 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>Drawer · CAD</div><div className="text-[13.5px] font-bold" style={{ color: CD.ink, fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums' }}>{fmt(tillCad(t), 'CAD')}</div></div>
                    <div className="flex items-center gap-1.5 flex-none">
                      {tillCad(t) === 0 && !isActive && !t.operator && (b.tills || []).length > 1 ? (
                        <button onClick={() => setConfirmDel({ bId: b.id, tId: t.id })} title="Empty drawer — delete this till" className="grid place-items-center" style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${CD.line}`, background: 'var(--cd-panel)' }}><Ic n="trash" s={13} c={CD.mute} /></button>
                      ) : null}
                      <button onClick={() => toggleTill(b.id, t.id)} title={tClosed ? 'Open till' : 'Close till'} className="text-[9.5px] px-1.5 py-1 font-semibold" style={{ background: tClosed ? CD.lineSoft : CD.greenSoft, color: tClosed ? CD.mute : CD.green, borderRadius: 6 }}>{tClosed ? 'CLOSED' : 'OPEN'}</button>
                      {isActive ? <button onClick={() => onOpenTill && onOpenTill()} title="Open the Cash Drawer for this till" className="text-[11px] px-2.5 py-1.5 font-semibold" style={{ color: CD.brass, border: 0, background: 'transparent', cursor: 'pointer' }}>Open drawer ›</button>
                        : <button onClick={() => makeActive(b.id, t.id)} disabled={closed || tClosed} title={occupied ? `${t.operator} is on this till — taking over is logged as a handover` : 'Work from this till'} className="text-[11px] px-2.5 py-1.5 font-semibold text-white" style={{ background: (closed || tClosed) ? 'var(--cd-disabled)' : occupied ? CD.brass : CD.ink, borderRadius: 7, cursor: (closed || tClosed) ? 'not-allowed' : 'pointer' }}>{occupied ? 'Take over' : 'Operate'}</button>}
                    </div>
                  </div>); })}
              </div>
            </div>); })}
          <p className="text-[11px]" style={{ color: CD.faint }}>Cash lives in the <b>vault</b>; tills borrow from it — <b>Issue float</b> at open, <b>Return</b> at close, tallied on the movements ledger. Set which till you're working from with <b>Operate</b>. The green dot is a live session: it follows sign-ins and frees the till at sign-out. Who <b>may</b> work here is arranged on the <b>Team</b> board.</p>
        </div>)}

        {/* ===================== TEAM — drag-and-drop assignment board ===================== */}
        {tab === 'team' && <TeamBoard me={me} log={log} branches={branches} setBranches={setBranches} settings={settings} setSettings={setSettings} />}


        {/* ===================== HISTORY — every dollar in and out, recorded ===================== */}
        {tab === 'movements' && (() => {
          const scopeB = branches.find(b => b.id === histScope);
          const scoped = !scopeB ? moves : moves.filter(m => String(m.from).startsWith(scopeB.code) || String(m.to).startsWith(scopeB.code));
          const today = scoped.filter(m => m.date === TODAY);
          const sumIf = (f) => today.filter(f).reduce((s, m) => s + (m.cadVal || 0), 0);
          const issued = sumIf(m => m.kind === 'issue');
          const returned = sumIf(m => m.kind === 'return');
          const ordered = sumIf(m => m.kind === 'order');
          const runs = sumIf(m => m.kind === 'vault' || m.kind === 'branch');
          const dirOf = (m) => {
            if (!scopeB) return null;
            const fromHere = String(m.from).startsWith(scopeB.code), toHere = String(m.to).startsWith(scopeB.code);
            return fromHere && toHere ? 'int' : fromHere ? 'out' : 'in';
          };
          return (<div>
            <div className="flex items-center justify-between mb-3">
              <div className="grid grid-cols-4 gap-2 flex-1" style={{ maxWidth: 720 }}>
                {[['Ordered in · today', fmt(ordered, 'CAD'), CD.green], ['Issued to tills · today', fmt(issued, 'CAD'), CD.mute], ['Back to vaults · today', fmt(returned, 'CAD'), CD.green], ['Between branches · today', fmt(runs, 'CAD'), 'var(--cd-brass-text, ' + CD.brass + ')']].map(([l, v, c]) => (
                  <div key={l} className="px-3 py-2" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[9.5px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-[15px] font-bold" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
              </div>
              <select value={histScope} onChange={e => setHistScope(e.target.value)} className="text-[12px] px-2.5 py-2 outline-none ml-3" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, background: 'var(--cd-panel)', color: CD.ink }}>
                <option value="all">All branches</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
            </div>
            <div className="overflow-hidden" style={{ border: `1px solid ${CD.line}`, background: CD.panel, borderRadius: 11 }}>
            <table className="w-full text-sm border-collapse">
              <thead><tr style={{ background: 'var(--cd-chip)', color: CD.mute }} className="text-[10.5px] uppercase tracking-wide text-left">{scopeB && <th className="px-3 py-2" style={{ width: 44 }}>In/Out</th>}<th className="px-3 py-2">Ref</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">From</th><th className="px-3 py-2">To</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">CAD</th><th className="px-3 py-2">By</th></tr></thead>
              <tbody>{scoped.map(m => { const KB = { issue: ['ISSUE', CD.greenSoft, CD.green], return: ['RETURN', 'var(--cd-chip)', CD.mute], order: ['ORDER IN', CD.greenSoft, CD.green], vault: ['VAULT RUN', CD.brassSoft, 'var(--cd-brass-text, ' + CD.brass + ')'], till: ['TILL', CD.lineSoft, CD.mute], branch: ['VAULT RUN', CD.brassSoft, 'var(--cd-brass-text, ' + CD.brass + ')'] }[m.kind] || ['MOVE', CD.lineSoft, CD.mute]; const d = dirOf(m); return (<tr key={m.id} style={{ borderTop: `1px solid ${CD.lineSoft}` }}>
                {scopeB && <td className="px-3 py-2">{d === 'int' ? <span className="text-[10px]" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>⇄</span> : <span className="grid place-items-center" style={{ width: 18, height: 18, borderRadius: 5, background: d === 'in' ? CD.greenSoft : CD.lineSoft, display: 'inline-grid' }}><Ic n={d === 'in' ? 'arrowdown' : 'arrowup'} s={11} c={d === 'in' ? CD.green : CD.mute} /></span>}</td>}
                <td className="px-3 py-2" style={{ fontFamily: 'Space Mono', fontSize: 11.5, color: CD.mute }}>{m.ref}</td>
                <td className="px-3 py-2" style={{ color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{m.date}</td>
                <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5 font-semibold" style={{ background: KB[1], color: KB[2], borderRadius: 5 }}>{KB[0]}</span></td>
                <td className="px-3 py-2 font-medium" style={{ color: CD.ink }}>{m.from}</td>
                <td className="px-3 py-2" style={{ color: CD.ink }}><Ic n="arrowright" s={11} c={CD.faint} /> {m.to}</td>
                <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.ink }}>{num(m.amount)} {m.ccy}</td>
                <td className="px-3 py-2 text-right" style={{ fontFamily: 'Space Mono', fontVariantNumeric: 'tabular-nums', color: CD.mute }}>{fmt(m.cadVal, 'CAD')}</td>
                <td className="px-3 py-2 text-[11.5px]" style={{ color: CD.mute }}>{m.by}</td>
              </tr>); })}
              {!scoped.length && <tr><td colSpan={scopeB ? 9 : 8} className="px-3 py-10 text-center text-[12px]" style={{ color: CD.faint }}>{scopeB ? `Nothing on the rail at ${scopeB.code} yet.` : (<span>No movements yet. <b>Issue float</b> to a till at open, <b>Return</b> its cash at close, or run a <b>vault run</b> between branches.</span>)}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px]" style={{ color: CD.faint }}>Every dollar that moves is recorded here forever — vault → till at open, till → vault at close, vault → vault between branches. Each entry debits one box and credits another; the network total never changes, only where the cash sits.</p>
          </div>);
        })()}
      </div>
      {moving && <MoveModal branches={branches} station={station} preset={moving} onClose={() => setMoving(null)} onMove={doMove} />}
      {pendingSt && (() => { const pb = branches.find(x => x.id === pendingSt.bId); const pt = pb && (pb.tills || []).find(x => x.id === pendingSt.tId); return pb && pt ? <ConfirmStationModal branch={pb} till={pt} me={me} onClose={() => setPendingSt(null)} onConfirm={() => doSwitch(pendingSt.bId, pendingSt.tId)} /> : null; })()}
      {confirmDel && (() => {
        const cb = branches.find(x => x.id === confirmDel.bId); const ct = cb && (cb.tills || []).find(x => x.id === confirmDel.tId);
        if (!cb || !ct) return null;
        return (<Portal><div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'var(--cd-scrim)', zIndex: 9400 }} onMouseDown={() => setConfirmDel(null)}>
          <div onMouseDown={e => e.stopPropagation()} className="w-full" style={{ maxWidth: 400, background: CD.paper, border: `1px solid ${CD.ink}`, borderRadius: 14, boxShadow: '0 24px 60px var(--cd-scrim)' }}>
            <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: `1px solid ${CD.line}` }}>
              <span className="grid place-items-center flex-none" style={{ width: 30, height: 30, background: CD.flagSoft, borderRadius: 8 }}><Ic n="trash" s={15} c={CD.flag} /></span>
              <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Delete this till?</div><div className="text-[11px]" style={{ color: CD.mute }}>{cb.name} · {ct.name}</div></div>
            </div>
            <div className="px-5 py-4">
              <div className="flex items-center justify-between px-3 py-2.5 mb-3" style={{ background: 'var(--cd-chip)', borderRadius: 9 }}>
                <span className="text-[11.5px]" style={{ color: CD.mute }}>Drawer balance</span>
                <span className="text-[13px] font-bold" style={{ fontFamily: 'Space Mono', color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{fmt(0, 'CAD')} — empty ✓</span>
              </div>
              <p className="text-[12px] m-0" style={{ color: CD.mute, lineHeight: 1.55 }}>The till is removed from {cb.code} and its slot is freed ({(cb.tills || []).length - 1} of {10} after this). Its past movements stay in History forever — deleting a till never deletes its record.</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${CD.line}`, background: 'var(--cd-panel)', borderRadius: '0 0 14px 14px' }}>
              <button onClick={() => setConfirmDel(null)} className="px-3.5 py-2 text-sm" style={{ border: `1px solid ${CD.line}`, borderRadius: 8 }}>Keep till</button>
              <button onClick={() => deleteTill(confirmDel.bId, confirmDel.tId)} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.flag, borderRadius: 8 }}><Ic n="trash" s={14} c="var(--cd-on-ink)" /> Delete till</button>
            </div>
          </div>
        </div></Portal>);
      })()}
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { Branches, TeamBoard });
  window.CDOS._stations = { SKEY, MKEY, defaultBranches, defaultStation, branchCad, tillCad, branchUnits, vaultCad, tillsCad, applyMove, MoveModal, AddBranchModal, ConfirmStationModal };
})();
