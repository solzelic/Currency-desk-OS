/* ============================================================
   CurrencyDesk OS — Ledger Import
   Owner / manager tool: drop a CSV or Excel export, map the
   columns to the house format, review, and post into the ledger.
   ============================================================ */
(function () {
  const { useState, useMemo, useRef } = React;
  const { CD, Ic, fmt, num, TYPES, CCY, newTx, mkRef, TODAY, crossRate } = window.CDOS;

  const ICFG_KEY = 'cdos_import_cfg_v1';
  const DEF_CFG = { dateFormat: 'auto', defaultInCcy: 'CAD', defaultType: 'Currency Exchange', autoCreateClients: true, skipDuplicateRefs: true };
  const loadCfg = () => { try { return Object.assign({}, DEF_CFG, JSON.parse(localStorage.getItem(ICFG_KEY) || '{}') || {}); } catch (e) { return Object.assign({}, DEF_CFG); } };
  const saveCfgPatch = (patch) => { const next = Object.assign({}, loadCfg(), patch); try { localStorage.setItem(ICFG_KEY, JSON.stringify(next)); } catch (e) {} return next; };

  // target fields the ledger understands, in display order
  const TARGETS = [
    { key: 'date', label: 'Date', req: true },
    { key: 'time', label: 'Time' },
    { key: 'customer', label: 'Customer', req: true },
    { key: 'type', label: 'Transaction type' },
    { key: 'beneficiary', label: 'Beneficiary' },
    { key: 'inAmt', label: 'Pay-in amount', req: true },
    { key: 'inCcy', label: 'Pay-in currency' },
    { key: 'outAmt', label: 'Pay-out amount' },
    { key: 'outCcy', label: 'Pay-out currency' },
    { key: 'rate', label: 'Rate' },
    { key: 'fee', label: 'Fee' },
    { key: 'ref', label: 'Reference' },
    { key: 'notes', label: 'Notes / memo' },
    { key: 'teller', label: 'Teller' },
  ];
  const SYN = {
    date: ['date', 'txndate', 'transactiondate', 'day', 'dealdate', 'valuedate'],
    time: ['time', 'txntime', 'timestamp'],
    customer: ['customer', 'client', 'name', 'sender', 'payer', 'conductor', 'clientname', 'customername'],
    type: ['type', 'transactiontype', 'product', 'service', 'txntype', 'category'],
    beneficiary: ['beneficiary', 'recipient', 'payee', 'receiver', 'beneficiaryname'],
    inAmt: ['payin', 'payinamount', 'amountin', 'amount', 'inamount', 'paidin', 'debit', 'sellamount', 'fromamount', 'amountpaid'],
    inCcy: ['payincurrency', 'incurrency', 'fromcurrency', 'currencyin', 'sellcurrency', 'currency', 'ccyin', 'fromccy'],
    outAmt: ['payout', 'payoutamount', 'amountout', 'paidout', 'credit', 'buyamount', 'toamount', 'received', 'amountreceived'],
    outCcy: ['payoutcurrency', 'outcurrency', 'tocurrency', 'currencyout', 'buycurrency', 'ccyout', 'toccy', 'receivedcurrency'],
    rate: ['rate', 'fxrate', 'exchangerate', 'rateapplied'],
    fee: ['fee', 'commission', 'charge', 'fees', 'servicefee'],
    ref: ['ref', 'reference', 'id', 'txnid', 'transactionid', 'number', 'refno', 'referencenumber'],
    notes: ['notes', 'memo', 'description', 'purpose', 'remarks', 'note', 'comment'],
    teller: ['teller', 'agent', 'staff', 'cashier', 'operator', 'processedby', 'handledby'],
  };

  /* ---------- parsing ---------- */
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pad = (n) => String(n).padStart(2, '0');

  // delimited text → array of string[] rows. Handles quotes, escaped quotes, embedded newlines.
  function parseDelimited(text, delim) {
    const rows = []; let row = [], field = '', i = 0, q = false; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }
  function sniffDelim(text) {
    const head = text.split(/\r?\n/).slice(0, 5).join('\n');
    const counts = { ',': (head.match(/,/g) || []).length, '\t': (head.match(/\t/g) || []).length, ';': (head.match(/;/g) || []).length };
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
  }

  // ---- minimal XLSX reader (central-directory zip + inflate-raw) ----
  const u16 = (d, o) => d[o] | (d[o + 1] << 8);
  const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('no-inflate');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzip(ab) {
    const d = new Uint8Array(ab);
    let eocd = -1;
    for (let i = d.length - 22; i >= 0; i--) { if (u32(d, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('not-xlsx');
    const cd = u32(d, eocd + 16), total = u16(d, eocd + 10);
    const files = {}; let p = cd;
    for (let k = 0; k < total; k++) {
      if (u32(d, p) !== 0x02014b50) break;
      const method = u16(d, p + 10), compSize = u32(d, p + 20);
      const nameLen = u16(d, p + 28), extraLen = u16(d, p + 30), commentLen = u16(d, p + 32);
      const lho = u32(d, p + 42);
      const name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = u16(d, lho + 26), lExtraLen = u16(d, lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const comp = d.subarray(start, start + compSize);
      let content = null;
      if (method === 0) content = comp; else if (method === 8) content = await inflateRaw(comp);
      if (content) files[name] = content;
      p = p + 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }
  const dec = (b) => new TextDecoder().decode(b);
  const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  function colToIdx(ref) { const m = String(ref).match(/^([A-Z]+)/); if (!m) return 0; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
  async function parseXlsx(ab) {
    const files = await unzip(ab);
    // shared strings
    const shared = [];
    if (files['xl/sharedStrings.xml']) {
      const xml = dec(files['xl/sharedStrings.xml']);
      (xml.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => {
        const txt = (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => xmlUnesc(t.replace(/<[^>]+>/g, ''))).join('');
        shared.push(txt);
      });
    }
    // first worksheet by workbook order; fall back to sheet1
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const sheetKeys = Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    if (sheetKeys.length) sheetPath = sheetKeys[0];
    if (!files[sheetPath]) throw new Error('no-sheet');
    const sx = dec(files[sheetPath]);
    const rowsXml = sx.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
    const grid = [];
    rowsXml.forEach(rx => {
      const cells = rx.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
      const arr = [];
      cells.forEach(cx => {
        const rAttr = (cx.match(/r="([A-Z]+\d+)"/) || [])[1];
        const idx = rAttr ? colToIdx(rAttr) : arr.length;
        const tAttr = (cx.match(/\st="([^"]+)"/) || [])[1];
        let val = '';
        if (tAttr === 'inlineStr') { val = xmlUnesc(((cx.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || ''); }
        else { const v = (cx.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1]; if (v != null) { val = (tAttr === 's') ? (shared[+v] || '') : xmlUnesc(v); } }
        arr[idx] = val;
      });
      for (let i = 0; i < arr.length; i++) if (arr[i] == null) arr[i] = '';
      grid.push(arr);
    });
    return grid.filter(r => r.some(c => String(c).trim() !== ''));
  }

  /* ---------- value coercion ---------- */
  function toISO(raw, fmt) {
    if (raw == null) return null;
    let s = String(raw).trim(); if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) { const v = parseFloat(s); if (v >= 30000 && v <= 60000) { const ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000; return new Date(ms).toISOString().slice(0, 10); } }
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) { const mo = +m[2], da = +m[3]; if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return `${m[1]}-${pad(mo)}-${pad(da)}`; }
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3]; if (y < 100) y += 2000; let mo, da;
      if (fmt === 'MDY') { mo = a; da = b; } else if (fmt === 'DMY') { da = a; mo = b; }
      else { if (a > 12) { da = a; mo = b; } else if (b > 12) { mo = a; da = b; } else { da = a; mo = b; } }
      if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
      return `${y}-${pad(mo)}-${pad(da)}`;
    }
    const d = new Date(s); if (!isNaN(d)) return d.toISOString().slice(0, 10);
    return null;
  }
  const toNum = (raw) => { if (raw == null) return null; const s = String(raw).replace(/[$,\s]/g, '').replace(/[^\d.\-]/g, ''); if (s === '' || s === '-' || s === '.') return null; const n = parseFloat(s); return isNaN(n) ? null : n; };
  const toTime = (raw) => { const s = String(raw || '').trim(); const m = s.match(/(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : ''; };
  function matchType(raw) {
    const v = norm(raw); if (!v) return null;
    const exact = TYPES.find(t => norm(t) === v); if (exact) return exact;
    if (/(remit|transfer|wire|send)/.test(v)) return /(receive|inbound|incoming)/.test(v) ? 'Remittance — Receive' : 'Remittance — Send';
    if (/(cheque|check)/.test(v)) return 'Cheque Cashing';
    if (/(moneyorder|mo\b|draft)/.test(v)) return 'Money Order';
    if (/(bill|utility|payment)/.test(v)) return 'Bill Payment';
    if (/(exchange|fx|buy|sell|convert|currency)/.test(v)) return 'Currency Exchange';
    return null;
  }

  /* ---------- auto-map headers ---------- */
  function autoMap(headers) {
    const map = {}; const used = new Set();
    const nheaders = headers.map(norm);
    TARGETS.forEach(t => {
      const syns = SYN[t.key] || [];
      for (let i = 0; i < nheaders.length; i++) {
        if (used.has(i)) continue;
        if (nheaders[i] && (syns.includes(nheaders[i]) || syns.some(sy => nheaders[i] === sy))) { map[t.key] = i; used.add(i); return; }
      }
      // looser contains pass
      for (let i = 0; i < nheaders.length; i++) {
        if (used.has(i)) continue;
        if (nheaders[i] && syns.some(sy => nheaders[i].includes(sy) || sy.includes(nheaders[i]))) { map[t.key] = i; used.add(i); return; }
      }
    });
    return map;
  }

  /* ---------- build a preview row ---------- */
  function buildRow(cells, map, cfg, existingRefs) {
    const g = (k) => { const i = map[k]; return (i == null || i < 0) ? '' : (cells[i] == null ? '' : String(cells[i]).trim()); };
    const errors = [], warns = [];
    const date = toISO(g('date'), cfg.dateFormat);
    if (!date) errors.push('date');
    const customer = g('customer');
    if (!customer) errors.push('customer');
    const inAmt = toNum(g('inAmt'));
    if (inAmt == null || inAmt <= 0) errors.push('amount');
    let inCcy = (g('inCcy') || cfg.defaultInCcy || 'CAD').toUpperCase().slice(0, 3);
    if (!/^[A-Z]{3}$/.test(inCcy)) { inCcy = (cfg.defaultInCcy || 'CAD'); warns.push('pay-in ccy'); }
    else if (!CCY.includes(inCcy)) warns.push('ccy ' + inCcy);
    let type = matchType(g('type'));
    if (!type) { type = cfg.defaultType || 'Currency Exchange'; if (g('type')) warns.push('type→' + type.split(' ')[0]); }
    const flat = (type === 'Cheque Cashing' || type === 'Money Order' || type === 'Bill Payment');
    let outCcy = (g('outCcy') || '').toUpperCase().slice(0, 3);
    if (!/^[A-Z]{3}$/.test(outCcy)) outCcy = flat ? inCcy : (inCcy === 'CAD' ? 'USD' : 'CAD');
    let rate = toNum(g('rate'));
    let outAmt = toNum(g('outAmt'));
    if (inAmt != null) {
      if (outAmt == null && rate != null) outAmt = +(inAmt * rate).toFixed(2);
      else if (outAmt == null) { const cr = inCcy === outCcy ? 1 : crossRate(inCcy, outCcy); outAmt = +(inAmt * (cr || 1)).toFixed(2); }
      if (rate == null) rate = inAmt ? +(outAmt / inAmt).toFixed(6) : (inCcy === outCcy ? 1 : crossRate(inCcy, outCcy));
    }
    const fee = toNum(g('fee'));
    const ref = g('ref');
    if (ref && existingRefs.has(ref)) warns.push('dup ref');
    return {
      ok: errors.length === 0, errors, warns,
      tx: { date: date || '', time: toTime(g('time')), customer, type, beneficiary: g('beneficiary'),
        inCcy, inAmt: inAmt == null ? '' : inAmt, outCcy, outAmt: outAmt == null ? '' : outAmt,
        rate: rate == null ? '' : rate, fee: fee == null ? '' : fee, notes: g('notes'), teller: g('teller'), ref },
    };
  }

  /* ---------- small UI atoms ---------- */
  function Seg({ value, onChange, options }) {
    return (<div className="inline-flex p-0.5" style={{ background: CD.lineSoft, borderRadius: 8 }}>
      {options.map(o => <button key={o.v} onClick={() => onChange(o.v)} className="px-2.5 py-1 text-[11.5px] font-medium" style={{ borderRadius: 6, background: value === o.v ? 'var(--cd-panel)' : 'transparent', color: value === o.v ? CD.ink : CD.mute, boxShadow: value === o.v ? '0 1px 2px var(--cd-hover-strong)' : 'none' }}>{o.l}</button>)}
    </div>);
  }
  function Toggle({ on, onClick }) {
    return (<button onClick={onClick} className="flex-none" style={{ width: 38, height: 22, borderRadius: 999, background: on ? CD.green : CD.line, position: 'relative', transition: 'background .15s' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: '50%', background: 'var(--cd-panel)', transition: 'left .15s', boxShadow: '0 1px 2px var(--cd-shade)' }} />
    </button>);
  }

  /* ---------- main ---------- */
  function LedgerImport({ rows, setRows, clients, setClients, settings, me, log, onOpenLedger }) {
    const isOwner = me && me.role === 'Owner';
    const [cfg] = useState(loadCfg);
    const [step, setStep] = useState('upload');     // upload | map | review | done
    const [fileName, setFileName] = useState('');
    const [grid, setGrid] = useState(null);          // string[][]
    const [hasHeader, setHasHeader] = useState(true);
    const [map, setMap] = useState({});
    const [parsing, setParsing] = useState(false);
    const [parseErr, setParseErr] = useState('');
    const [drag, setDrag] = useState(false);
    const [result, setResult] = useState(null);
    const fileRef = useRef(null);

    const existingRefs = useMemo(() => new Set(rows.map(r => r.ref).filter(Boolean)), [rows]);
    const headers = useMemo(() => { if (!grid || !grid.length) return []; return hasHeader ? grid[0].map(h => String(h || '').trim()) : grid[0].map((_, i) => 'Column ' + (i + 1)); }, [grid, hasHeader]);
    const dataRows = useMemo(() => { if (!grid) return []; return hasHeader ? grid.slice(1) : grid; }, [grid, hasHeader]);
    const preview = useMemo(() => dataRows.map(c => buildRow(c, map, cfg, existingRefs)), [dataRows, map, cfg, existingRefs]);
    const validRows = preview.filter(p => p.ok);
    const dupCount = preview.filter(p => p.ok && p.warns.includes('dup ref')).length;

    async function handleFile(file) {
      if (!file) return;
      setParsing(true); setParseErr(''); setFileName(file.name); setResult(null);
      try {
        let g;
        if (/\.xlsx$/i.test(file.name)) { g = await parseXlsx(await file.arrayBuffer()); }
        else { const text = await file.text(); g = parseDelimited(text, sniffDelim(text)); }
        if (!g || !g.length) throw new Error('empty');
        setGrid(g);
        const hdr = g[0].map(h => String(h || '').trim());
        // header heuristic: first row mostly non-numeric labels
        const looksHeader = hdr.filter(h => h && isNaN(parseFloat(h))).length >= Math.ceil(hdr.length / 2);
        setHasHeader(looksHeader);
        setMap(autoMap(looksHeader ? hdr : hdr.map((_, i) => '')));
        setStep('map');
      } catch (e) {
        setParseErr(/\.xlsx$/i.test(file.name)
          ? "Couldn't read this Excel file. Try re-saving it as CSV (File ▸ Save As ▸ CSV) and uploading that."
          : "Couldn't parse this file. Make sure it's a CSV, TSV, or Excel export.");
        setStep('upload');
      } finally { setParsing(false); }
    }
    const onPick = (e) => { const f = e.target.files && e.target.files[0]; handleFile(f); e.target.value = ''; };
    const onDrop = (e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files && e.dataTransfer.files[0]; handleFile(f); };

    const reset = () => { setStep('upload'); setGrid(null); setMap({}); setFileName(''); setParseErr(''); setResult(null); };

    function doImport() {
      const seqByDate = {};
      rows.forEach(r => { if (r.date) seqByDate[r.date] = Math.max(seqByDate[r.date] || 0, parseInt(String(r.ref).slice(-3), 10) || 0); });
      const skipDup = cfg.skipDuplicateRefs;
      const newRows = []; const newClients = {}; let skipped = 0;
      validRows.forEach(p => {
        const t = p.tx;
        if (skipDup && t.ref && existingRefs.has(t.ref)) { skipped++; return; }
        let ref = t.ref;
        if (!ref) { const seq = (seqByDate[t.date] || 0) + 1; seqByDate[t.date] = seq; ref = mkRef(t.date, seq); }
        const stamp = `${t.date} ${t.time || '00:00'}`;
        newRows.push(newTx({
          ref, date: t.date, time: t.time || '00:00', customer: t.customer, beneficiary: t.beneficiary || '',
          type: t.type, inCcy: t.inCcy, inAmt: t.inAmt, rate: t.rate === '' ? 1 : t.rate, outCcy: t.outCcy, outAmt: t.outAmt,
          fee: t.fee === '' ? '' : t.fee, teller: t.teller || me.name, notes: t.notes || '',
          thread: t.notes ? [{ ts: stamp, user: me.name, text: t.notes }] : [],
          createdBy: me.name, createdAt: `imported ${new Date().toLocaleString('en-CA', { hour12: false }).replace(',', '')}`,
          importedFrom: fileName,
        }));
        if (cfg.autoCreateClients && t.customer && !clients[t.customer] && !newClients[t.customer]) {
          newClients[t.customer] = { name: t.customer, kind: 'individual', createdVia: 'import', note: `Added on import from ${fileName}` };
        }
      });
      if (Object.keys(newClients).length) setClients(c => Object.assign({}, c, newClients));
      if (newRows.length) setRows(rs => [...newRows, ...rs]);
      log && log('Ledger import', `${newRows.length} record${newRows.length === 1 ? '' : 's'} from ${fileName}${skipped ? ` · ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}`);
      setResult({ imported: newRows.length, clients: Object.keys(newClients).length, skipped });
      setStep('done');
    }

    function downloadTemplate() {
      const head = 'Date,Time,Customer,Type,Beneficiary,Pay-in amount,Pay-in currency,Pay-out amount,Pay-out currency,Rate,Fee,Reference,Notes';
      const ex = [
        '2026-06-18,09:41,Jakob Miller,Currency Exchange,,2400,CAD,1752,USD,0.73,18,,Walk-in buy USD',
        '2026-06-18,10:12,Rachel Carter,Remittance — Send,M. Carter · Cebu,600,CAD,24300,PHP,40.5,9.99,,Cebu pickup',
        '2026-06-17,11:05,Jakob Miller,Cheque Cashing,,1850,CAD,1813,CAD,1,37,,Payroll cheque',
      ];
      const blob = new Blob([head + '\n' + ex.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ledger-import-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    if (!isOwner && !(me && me.role === 'Manager')) {
      return (<div className="p-8 text-center" style={{ color: CD.mute }}><Ic n="lock" s={26} c={CD.faint} /><div className="mt-3 text-sm">Ledger import is limited to owner and manager accounts.</div></div>);
    }

    const Head = (
      <div className="px-5 pt-4 pb-3 flex-none" style={{ background: CD.panel, borderBottom: `1px solid ${CD.line}` }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center" style={{ width: 30, height: 30, background: CD.ink, borderRadius: 8 }}><Ic n="download" s={16} c="var(--cd-on-ink)" /></span>
            <div><div className="font-semibold leading-tight" style={{ color: CD.ink }}>Ledger Import</div><div className="text-[11px]" style={{ color: CD.mute }}>Bring a CSV or Excel export into the house ledger</div></div>
          </div>
          <div className="flex items-center gap-2">
            {step !== 'upload' && <button onClick={reset} className="text-[12px] font-medium px-2.5 py-1.5" style={{ border: `1px solid ${CD.line}`, borderRadius: 8, color: CD.mute, background: 'var(--cd-on-ink)' }}>Start over</button>}
          </div>
        </div>
      </div>
    );

    return (<div className="flex flex-col" style={{ height: '100%', background: CD.paper }}>
      {Head}
      <div className="flex-1 overflow-auto">

        {step === 'upload' && (
          <div className="p-5">
            <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
              className="grid place-items-center text-center px-6 py-14" style={{ border: `2px dashed ${drag ? CD.ink : CD.line}`, borderRadius: 16, background: drag ? CD.lineSoft : CD.panel, transition: 'background .15s, border-color .15s' }}>
              <span className="grid place-items-center mb-3" style={{ width: 52, height: 52, borderRadius: 14, background: CD.lineSoft }}><Ic n="download" s={24} c={CD.ink} /></span>
              <div className="text-[15px] font-semibold" style={{ color: CD.ink }}>{parsing ? 'Reading file…' : 'Drop a CSV or Excel file here'}</div>
              <div className="text-[12px] mt-1 mb-4" style={{ color: CD.mute }}>We'll read the columns and map them to Date, Customer, Type, amounts and more.</div>
              <div className="flex items-center gap-2">
                <button onClick={() => fileRef.current && fileRef.current.click()} disabled={parsing} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9, opacity: parsing ? 0.6 : 1 }}><Ic n="upload" s={15} c="var(--cd-on-ink)" /> Choose file</button>
                <button onClick={downloadTemplate} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="filetext" s={15} c={CD.mute} /> Template</button>
              </div>
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={onPick} style={{ display: 'none' }} />
            </div>
            {parseErr && <div className="mt-3 px-3 py-2.5 flex items-start gap-2 text-[12px]" style={{ background: CD.flagSoft, border: `1px solid ${CD.flag}`, borderRadius: 10, color: CD.flag }}><Ic n="alert" s={14} c={CD.flag} /><span>{parseErr}</span></div>}
            <div className="mt-4 text-[11.5px]" style={{ color: CD.faint }}>Recognised columns: Date, Time, Customer, Type, Beneficiary, Pay-in amount &amp; currency, Pay-out amount &amp; currency, Rate, Fee, Reference, Notes, Teller. Missing pieces (rate, pay-out) are computed at the live mid where possible.</div>
          </div>
        )}

        {step === 'map' && grid && (
          <div className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div><div className="text-sm font-semibold" style={{ color: CD.ink }}>Match the columns</div><div className="text-[11px]" style={{ color: CD.mute }}><b style={{ color: CD.ink }}>{fileName}</b> · {dataRows.length} row{dataRows.length === 1 ? '' : 's'} · {headers.length} columns</div></div>
              <label className="flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: CD.ink }}><Toggle on={hasHeader} onClick={() => setHasHeader(h => !h)} /> First row is a header</label>
            </div>
            <div className="grid sm:grid-cols-2 gap-2 mb-4">
              {TARGETS.map(t => {
                const sel = map[t.key];
                const missingReq = t.req && (sel == null || sel < 0);
                return (<div key={t.key} className="flex items-center gap-2 px-3 py-2" style={{ background: CD.panel, border: `1px solid ${missingReq ? CD.flag : CD.line}`, borderRadius: 9 }}>
                  <span className="text-[12.5px] flex-1" style={{ color: CD.ink }}>{t.label}{t.req && <span style={{ color: CD.flag }}> *</span>}</span>
                  <select value={sel == null ? '' : sel} onChange={e => setMap(m => Object.assign({}, m, { [t.key]: e.target.value === '' ? -1 : +e.target.value }))} className="text-[12px] px-2 py-1 outline-none" style={{ border: `1px solid ${CD.line}`, borderRadius: 7, background: 'var(--cd-panel)', maxWidth: 190 }}>
                    <option value="">— not mapped —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || ('Column ' + (i + 1))}</option>)}
                  </select>
                </div>);
              })}
            </div>
            <div className="flex items-center justify-between">
              <div className="text-[12px]" style={{ color: validRows.length ? CD.green : CD.flag }}>{validRows.length} of {dataRows.length} rows ready{preview.length - validRows.length ? ` · ${preview.length - validRows.length} need attention` : ''}</div>
              <button onClick={() => setStep('review')} disabled={!validRows.length} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: validRows.length ? CD.ink : 'var(--cd-disabled)', borderRadius: 9, cursor: validRows.length ? 'pointer' : 'not-allowed' }}>Preview {validRows.length} rows <Ic n="chev" s={14} c="var(--cd-on-ink)" /></button>
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="p-5">
            <div className="grid grid-cols-4 gap-2 mb-3">
              {[['Ready to import', validRows.length, CD.green], ['Need attention', preview.length - validRows.length, preview.length - validRows.length ? CD.flag : CD.mute], ['Duplicates', dupCount, dupCount ? CD.amber : CD.mute], ['Total rows', preview.length, CD.ink]].map(([l, v, c], i) => (
                <div key={i} className="p-3" style={{ background: CD.panel, border: `1px solid ${CD.line}`, borderRadius: 10 }}><div className="text-[10px] uppercase tracking-widest" style={{ color: CD.faint, fontFamily: 'Space Mono, monospace' }}>{l}</div><div className="text-xl font-bold" style={{ color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>))}
            </div>
            <div style={{ border: `1px solid ${CD.line}`, borderRadius: 11, overflow: 'hidden' }}>
              <div className="overflow-auto" style={{ maxHeight: 360 }}>
                <table className="w-full text-[11.5px]" style={{ borderCollapse: 'collapse' }}>
                  <thead><tr style={{ background: CD.panel, position: 'sticky', top: 0 }}>
                    {['', 'Date', 'Customer', 'Type', 'Pay-in', 'Pay-out', 'Fee', 'Notes'].map((h, i) => <th key={i} className="px-2.5 py-2 text-left font-semibold" style={{ color: CD.mute, borderBottom: `1px solid ${CD.line}`, whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {preview.slice(0, 200).map((p, i) => {
                      const t = p.tx;
                      return (<tr key={i} style={{ background: p.ok ? 'var(--cd-panel)' : CD.flagSoft, borderBottom: `1px solid ${CD.lineSoft}` }}>
                        <td className="px-2.5 py-1.5">{p.ok ? <Ic n="check" s={13} c={CD.green} /> : <span title={'Missing: ' + p.errors.join(', ')}><Ic n="alert" s={13} c={CD.flag} /></span>}</td>
                        <td className="px-2.5 py-1.5" style={{ whiteSpace: 'nowrap', color: t.date ? CD.ink : CD.flag, fontFamily: 'Space Mono, monospace' }}>{t.date || '— no date —'}{t.time ? ' ' + t.time : ''}</td>
                        <td className="px-2.5 py-1.5" style={{ color: t.customer ? CD.ink : CD.flag }}>{t.customer || '— no name —'}</td>
                        <td className="px-2.5 py-1.5" style={{ color: CD.mute, whiteSpace: 'nowrap' }}>{t.type}{p.warns.some(w => w.startsWith('type')) && <span title="type defaulted" style={{ color: CD.amber }}> ·</span>}</td>
                        <td className="px-2.5 py-1.5" style={{ whiteSpace: 'nowrap', color: t.inAmt === '' ? CD.flag : CD.ink, fontVariantNumeric: 'tabular-nums' }}>{t.inAmt === '' ? '—' : `${num(t.inAmt)} ${t.inCcy}`}</td>
                        <td className="px-2.5 py-1.5" style={{ whiteSpace: 'nowrap', color: CD.green, fontVariantNumeric: 'tabular-nums' }}>{t.outAmt === '' ? '—' : `${num(t.outAmt)} ${t.outCcy}`}</td>
                        <td className="px-2.5 py-1.5" style={{ whiteSpace: 'nowrap', color: CD.mute, fontVariantNumeric: 'tabular-nums' }}>{t.fee === '' ? '—' : fmt(t.fee, 'CAD')}</td>
                        <td className="px-2.5 py-1.5" style={{ color: CD.faint, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.warns.includes('dup ref') ? <span style={{ color: CD.amber }}>duplicate ref</span> : (t.notes || '')}</td>
                      </tr>);
                    })}
                  </tbody>
                </table>
              </div>
              {preview.length > 200 && <div className="px-3 py-2 text-[11px]" style={{ color: CD.faint, borderTop: `1px solid ${CD.line}`, background: CD.panel }}>Showing first 200 of {preview.length} rows — all valid rows import.</div>}
            </div>
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => setStep('map')} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="arrowleft" s={14} c={CD.mute} /> Back to mapping</button>
              <window.CDOS.CommitBtn onCommit={doImport} disabled={!validRows.length} stage delay={520} icon="download" label={`Import ${validRows.length}${dupCount && cfg.skipDuplicateRefs ? ' (skip ' + dupCount + ' dup)' : ''} into ledger`} armLabel="Posting…" doneLabel="Posting…" title="Post these records into the ledger" style={{ borderRadius: 9 }} />
            </div>
            <div className="text-[11px] mt-2" style={{ color: CD.faint }}>Rows with a red flag are skipped. {cfg.autoCreateClients ? 'Unknown customers are added as new client records.' : 'Unknown customers are left unmatched.'} Imported deals run through the same compliance checks as anything booked at the counter.</div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="p-8 text-center">
            <span className="grid place-items-center mx-auto mb-3" style={{ width: 56, height: 56, borderRadius: 16, background: CD.greenSoft }}><Ic n="checkcircle" s={28} c={CD.green} /></span>
            <div className="text-[16px] font-semibold" style={{ color: CD.ink }}>Imported {result.imported} record{result.imported === 1 ? '' : 's'}</div>
            <div className="text-[12.5px] mt-1" style={{ color: CD.mute }}>from {fileName}{result.clients ? ` · ${result.clients} new client${result.clients === 1 ? '' : 's'} created` : ''}{result.skipped ? ` · ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''}.</div>
            <div className="flex items-center justify-center gap-2 mt-5">
              <button onClick={() => onOpenLedger && onOpenLedger()} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white" style={{ background: CD.ink, borderRadius: 9 }}><Ic n="scroll" s={15} c="var(--cd-on-ink)" /> Open ledger</button>
              <button onClick={reset} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium" style={{ border: `1px solid ${CD.line}`, borderRadius: 9, color: CD.ink, background: 'var(--cd-on-ink)' }}><Ic n="download" s={15} c={CD.mute} /> Import another</button>
            </div>
          </div>
        )}
      </div>
    </div>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { LedgerImport, importCfg: { load: loadCfg, save: saveCfgPatch, DEF: DEF_CFG } });
})();
