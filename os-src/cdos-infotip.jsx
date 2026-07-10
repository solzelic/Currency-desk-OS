/* ============================================================
   CurrencyDesk OS — InfoTip
   One reusable hover-help affordance used across the whole app:
   a small ⓘ dot that, on hover, shows a dark popover explaining a
   confusing term. Auto-dismisses the moment the cursor leaves; the
   popover is portalled to <body> and pointer-transparent so it never
   clips inside scroll panels and never flickers.

   Usage:
     <window.CDOS.InfoTip title="Companion obligations"
        body="When you file one report, a related one may also be due."
        example="LCTR often pairs with an STR" />
   ============================================================ */
(function () {
  const { useState, useRef } = React;
  const { CD, Ic } = window.CDOS;

  // one-time fade-in keyframes
  if (!document.getElementById('cdos-infotip-kf')) {
    const st = document.createElement('style');
    st.id = 'cdos-infotip-kf';
    st.textContent = '@keyframes cdosTipIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}.cdos-infotip-pop{animation:cdosTipIn .12s ease-out}';
    document.head.appendChild(st);
  }

  function InfoTip({ title, body, example, lines, size = 14, w = 252, tone }) {
    const [open, setOpen] = useState(false);
    const [box, setBox] = useState(null);
    const ref = useRef(null);
    const show = () => {
      const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const center = r.left + r.width / 2;
      let left = center - w / 2;
      left = Math.max(8, Math.min(left, vw - 8 - w));
      setBox({ left, top: r.bottom + 8, arrow: Math.max(10, Math.min(center - left, w - 14)) });
      setOpen(true);
    };
    const hide = () => setOpen(false);
    return (<span ref={ref} onMouseEnter={show} onMouseLeave={hide} className="inline-flex" style={{ verticalAlign: 'middle', lineHeight: 0 }}>
      <span className="grid place-items-center" style={{ width: size, height: size, borderRadius: '50%', border: `1px solid ${open ? CD.ink : CD.line}`, background: open ? CD.ink : 'transparent', cursor: 'help', transition: 'background .12s, border-color .12s', flex: 'none' }}>
        <Ic n="info" s={Math.round(size * 0.62)} c={open ? 'var(--cd-on-ink)' : CD.faint} />
      </span>
      {open && box && ReactDOM.createPortal(
        <div className="cdos-infotip-pop" style={{ position: 'fixed', left: box.left, top: box.top, width: w, zIndex: 10050, pointerEvents: 'none' }}>
          <div style={{ position: 'relative', background: '#16150f', color: '#ffffff', borderRadius: 10, boxShadow: '0 14px 34px -10px rgba(0,0,0,0.5)', lineHeight: 1.45, padding: '10px 11px', textAlign: 'left' }}>
            <span style={{ position: 'absolute', top: -5, left: box.arrow - 5, width: 10, height: 10, background: '#16150f', transform: 'rotate(45deg)', borderRadius: 1 }} />
            {title && <div className="text-[11.5px] font-semibold mb-1.5">{title}</div>}
            {body && <div className="text-[11px]" style={{ color: '#dcd9d1' }}>{body}</div>}
            {Array.isArray(lines) && lines.map((ln, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10.5px] mt-1.5" style={{ color: '#c8c4b8' }}>
                {ln.k && <span className="font-semibold flex-none" style={{ color: ln.c || '#ffffff', fontFamily: 'Space Mono, monospace' }}>{ln.k}</span>}
                <span className="flex-1">{ln.v}</span>
              </div>
            ))}
            {example && <div className="text-[10.5px] px-1.5 py-1 mt-2" style={{ background: 'rgba(255,255,255,0.14)', borderRadius: 6, fontFamily: 'Space Mono, monospace', color: '#f0eee7' }}>e.g.&nbsp;{example}</div>}
          </div>
        </div>, document.body)}
    </span>);
  }

  window.CDOS = Object.assign(window.CDOS || {}, { InfoTip });
})();
