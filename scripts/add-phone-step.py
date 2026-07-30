"""Insert the phone step into the Early Access design.

The designer's own export carries this step already; this session cannot
reach Claude Design to fetch it, so it is reproduced here from the
screenshot using the document's own primitives — same fonts, same card,
same chip and segmented-control styles as the steps either side of it.

Every edit is anchored and asserted, so a re-export that moves any of
these lines fails loudly instead of silently half-applying.
"""
import sys

P = "design/site/CurrencyDesk Early Access.dc.html"
src = open(P, encoding="utf-8").read()

def patch(why, frm, to, count=1):
    global src
    seen = src.count(frm)
    if seen != count:
        sys.exit(f"early-access: anchor moved — {why}\n  expected {count}, found {seen}\n  anchor: {frm[:110]!r}")
    src = src.replace(frm, to)

# ---- state -----------------------------------------------------------------
patch("wizard state",
  "      branches: 'single', stack: null, timeline: null, name: '', role: '', employees: null, jur: 'CA', seed: 0, toast: '', noWebsite: false, memberCount: 42",
  "      branches: 'single', stack: null, timeline: null, name: '', role: '', employees: null, jur: 'CA', seed: 0, toast: '', noWebsite: false, memberCount: 42,\n"
  "      phone: '', dial: '+1', bestTime: 'Any time'")

patch("focus refs",
  "    this.ref6 = React.createRef();",
  "    this.ref6 = React.createRef();\n    this.ref7 = React.createRef();")

patch("step→ref map",
  "    this._refByStep = { 0: 'ref0', 1: 'ref1', 2: 'ref2', 6: 'ref6' };",
  "    this._refByStep = { 0: 'ref0', 1: 'ref1', 2: 'ref2', 6: 'ref6', 7: 'ref7' };")

# ---- the wizard is one step longer -----------------------------------------
patch("skip-website clamp",
  "skipWebsite = () => this.setState((s) => ({ noWebsite: true, domain: '', step: Math.min(s.step + 1, 7) }));",
  "skipWebsite = () => this.setState((s) => ({ noWebsite: true, domain: '', step: Math.min(s.step + 1, 8) }));")

patch("next guard + clamp",
  "  next = () => {\n    if (this.state.step < 7 && !this.canNext()) {",
  "  next = () => {\n    if (this.state.step < 8 && !this.canNext()) {")
patch("next clamp",
  "    this.setState((s) => ({ step: Math.min(s.step + 1, 7) }));",
  "    this.setState((s) => ({ step: Math.min(s.step + 1, 8) }));")

patch("card arrival",
  "      if (this.state.step === 7) { setTimeout(() => this.startMemberCount(), 800); }",
  "      if (this.state.step === 8) { setTimeout(() => this.startMemberCount(), 800); }")

patch("dark theme on the ticket", "    const dark = step === 7;", "    const dark = step === 8;")
patch("form vs ticket", "      isForm: step < 7,", "      isForm: step < 8,")

# ---- phone helpers ---------------------------------------------------------
patch("phone helpers",
  "  set = (k) => (e) => this.setState({ [k]: e.target.value });",
  "  set = (k) => (e) => this.setState({ [k]: e.target.value });\n"
  "  /* Digits only, so formatting never decides whether a number is valid.\n"
  "     Ten is the North American length; anywhere else can be longer, and a\n"
  "     shop that types their number with spaces or dashes is not wrong. */\n"
  "  phoneDigits = () => String(this.state.phone || '').replace(/\\D+/g, '');\n"
  "  onPhone = (e) => {\n"
  "    const d = String(e.target.value || '').replace(/\\D+/g, '').slice(0, 15);\n"
  "    const p = this.state.dial === '+1' && d.length > 3\n"
  "      ? (d.length > 6 ? d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6) : d.slice(0, 3) + ' ' + d.slice(3))\n"
  "      : d;\n"
  "    this.setState({ phone: p });\n"
  "  };")

patch("phone validity",
  "      case 6: return s.name.trim().length > 1 && !!s.role && !!s.employees;",
  "      case 6: return s.name.trim().length > 1 && !!s.role && !!s.employees;\n"
  "      case 7: return this.phoneDigits().length >= 10;")

# ---- labels, pager, step count ---------------------------------------------
patch("button labels",
  "    const nextLabels = ['Apply for early access', 'Continue', 'Reserve it', 'Continue', 'Continue', 'Continue', 'Claim my membership'];",
  "    const nextLabels = ['Apply for early access', 'Continue', 'Reserve it', 'Continue', 'Continue', 'Continue', 'Continue', 'Claim my membership'];")

patch("pager dots", "    const pager = [0, 1, 2, 3, 4, 5, 6].map((i) => ({", "    const pager = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({")

patch("step counter",
  "      stepCount: 'Step ' + Math.min(step + 1, 7) + ' of 7',",
  "      stepCount: 'Step ' + Math.min(step + 1, 8) + ' of 8',")

patch("background washes",
  "      'rgba(29,107,69,0.08)', 'rgba(194,69,45,0.06)', 'rgba(90,63,128,0.06)', 'rgba(29,107,69,0.1)', 'rgba(29,107,69,0.14)'",
  "      'rgba(29,107,69,0.08)', 'rgba(194,69,45,0.06)', 'rgba(90,63,128,0.06)', 'rgba(29,107,69,0.1)',\n"
  "      'rgba(169,121,28,0.09)', 'rgba(29,107,69,0.14)'")

# ---- the ticket becomes step 8; step 7 is the phone ------------------------
patch("ticket condition", '    <sc-if value="{{ s7 }}">\n    <div style="position: relative; display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 8px 0 4px;">',
      '    <sc-if value="{{ s8 }}">\n    <div style="position: relative; display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 8px 0 4px;">')

patch("step flags",
  "      s0: step === 0, s1: step === 1, s2: step === 2, s3: step === 3, s4: step === 4, s5: step === 5, s6: step === 6, s7: step === 7,",
  "      s0: step === 0, s1: step === 1, s2: step === 2, s3: step === 3, s4: step === 4, s5: step === 5, s6: step === 6, s7: step === 7, s8: step === 8,")

# ---- bindings for the new step ---------------------------------------------
patch("phone bindings",
  "      role: s.role, onRole: this.set('role'), employeeOpts,",
  "      role: s.role, onRole: this.set('role'), employeeOpts,\n"
  "      phone: s.phone, onPhone: this.onPhone, ref7: this.ref7,\n"
  "      dial: s.dial, onDial: this.set('dial'), dialOpts, timeOpts, phoneHint,")

patch("phone option builders",
  "    const nextLabels = ",
  "    /* Country code as a short list rather than every dialling code on earth:\n"
  "       this is a Canadian product opening to the UK and Australia, and a\n"
  "       200-row select is a worse answer than a free-typed number. */\n"
  "    const dialOpts = [\n"
  "      { v: '+1', l: '+1 CA/US' }, { v: '+44', l: '+44 UK' }, { v: '+61', l: '+61 AU' },\n"
  "      { v: '+353', l: '+353 IE' }, { v: '+64', l: '+64 NZ' }\n"
  "    ];\n"
  "    const times = ['Any time', 'Mornings', 'Afternoons', 'After close'];\n"
  "    const timeOpts = times.map((t) => ({\n"
  "      label: t, onClick: this.pick('bestTime', t),\n"
  "      style: {\n"
  "        padding: '10px 18px', borderRadius: '999px', cursor: 'pointer',\n"
  "        fontFamily: \"'Schibsted Grotesk', sans-serif\", fontSize: '14px', fontWeight: 600,\n"
  "        border: '1px solid ' + (s.bestTime === t ? '#17140F' : '#DDD5C6'),\n"
  "        background: s.bestTime === t ? '#17140F' : 'transparent',\n"
  "        color: s.bestTime === t ? '#F1ECE1' : '#17140F', transition: 'all 0.2s ease'\n"
  "      }\n"
  "    }));\n"
  "    const digits = this.phoneDigits();\n"
  "    const phoneHint = digits.length === 0 ? 'A REAL NUMBER, PLEASE'\n"
  "      : digits.length < 10 ? 'A FEW MORE DIGITS' : 'THAT WILL DO';\n\n"
  "    const nextLabels = ")

# ---- the markup ------------------------------------------------------------
STEP = '''        <sc-if value="{{ s7 }}">
        <div style="animation: cdCardIn 0.55s cubic-bezier(0.2,0.8,0.2,1) both;">
          <div style="width: 46px; height: 46px; border-radius: 13px; background: rgba(169,121,28,0.12); display: grid; place-items: center;"><svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="#A9791C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path></svg></div>
          <h2 style="font-family: 'Instrument Serif', serif; font-weight: 400; font-size: 34px; line-height: 1.05; margin: 22px 0 0;">Where do we call you?</h2>
          <p style="font-size: 14px; line-height: 1.5; color: #6B6459; margin: 10px 0 0;">If we approve you, your phone rings within a few minutes. Fifteen minutes, mostly us listening — then a follow-up in a week once the desk is in your hands.</p>

          <div style="margin-top: 20px; display: flex; align-items: baseline; justify-content: space-between; gap: 12px;">
            <span style="font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em; color: #9C948A; font-weight: 600;">MOBILE · WE CALL THIS ONE</span>
            <span style="font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em; color: #B3AA9C;">{{ phoneHint }}</span>
          </div>
          <div style="margin-top: 8px; display: flex; gap: 10px;">
            <div style="position: relative; flex: none;">
              <select value="{{ dial }}" onChange="{{ onDial }}" style="height: 100%; box-sizing: border-box; padding: 15px 34px 15px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 15px; color: #17140F; background: #FFFDF8; border: 1.5px solid #DDD5C6; border-radius: 13px; outline: none; appearance: none; -webkit-appearance: none; cursor: pointer;" style-focus="border-color: #1D6B45; box-shadow: 0 0 0 4px rgba(29,107,69,0.13);">
                <sc-for list="{{ dialOpts }}" as="d" hint-placeholder-count="5">
                  <option value="{{ d.v }}">{{ d.l }}</option>
                </sc-for>
              </select>
              <span aria-hidden="true" style="position: absolute; right: 13px; top: 50%; transform: translateY(-50%); pointer-events: none; color: #6B6459; display: flex;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg></span>
            </div>
            <input ref="{{ ref7 }}" value="{{ phone }}" onInput="{{ onPhone }}" onKeyDown="{{ onKey }}" type="tel" inputmode="tel" autocomplete="tel-national" aria-label="Mobile number" placeholder="416 555 0148" style="flex: 1; min-width: 0; box-sizing: border-box; padding: 15px 18px; font-family: 'IBM Plex Mono', monospace; font-size: 16.5px; letter-spacing: 0.02em; color: #17140F; background: #FFFDF8; border: 1.5px solid #DDD5C6; border-radius: 13px; outline: none;" style-focus="border-color: #1D6B45; box-shadow: 0 0 0 4px rgba(29,107,69,0.13);">
          </div>

          <div style="margin-top: 16px;">
            <span style="font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em; color: #9C948A; font-weight: 600;">BEST TIME TO REACH YOU</span>
            <div style="margin-top: 9px; display: flex; flex-wrap: wrap; gap: 9px;">
              <sc-for list="{{ timeOpts }}" as="t" hint-placeholder-count="4">
                <button type="button" onClick="{{ t.onClick }}" style="{{ t.style }}">{{ t.label }}</button>
              </sc-for>
            </div>
          </div>

          <div style="margin: 18px 0 0; height: 1px; background: #E7DFCF;"></div>
          <div style="margin-top: 14px; display: flex; gap: 10px; align-items: flex-start;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#1D6B45" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-top: 2px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-4"></path></svg>
            <p style="font-size: 13px; line-height: 1.55; color: #6B6459; margin: 0;">One number, used for this call and to sign you in. Never sold, never used for marketing. <b style="color: #17140F;">SAM</b> places the call — a person reads every reply.</p>
          </div>
        </div>
        </sc-if>

'''

patch("insert the phone step before the action button",
  '        <!-- action button -->\n',
  STEP + '        <!-- action button -->\n')

open(P, "w", encoding="utf-8").write(src)
print("early-access design: phone step added, wizard is now 8 steps")
