/* Captures every sign-up / onboarding state at the sizes we design for: a screenshot and a
   measurements file (every visible element: box, font, colour, background, radius, border).

     node capture.cjs <base-url> <out-dir> [sizes]
       sizes: comma list of desktop,laptop,phone,small (default desktop,laptop,phone)

   Reviewer-owned copy of reference/tools/capture.cjs. Adds 1440×900, full text,
   explicit aria-hidden cdRise decoration metadata, and failing exit on a missing state.
   Frozen prototype/tool remain unchanged.

   Getting to a state:
   - Against the reference prototype (default), it uses the prototype's review rail to jump
     straight to a screen with the demo data filled in (Daniel Osei, York Currency Exchange,
     CD-YORK-7K42). The rail is hidden by ?bare=1 but still clickable from script.
   - Against your build, set STEP_URL to a URL template that opens a seeded test reservation
     at a step, e.g.  STEP_URL='http://localhost:5173/onboarding/CD-TEST-2345?step={step}'
     The {step} names are the `step` values below. Build that seed route for tests only
     (never in production). Everything after the jump is typing and clicking, as a visitor.

   Fixed clock: Friday 13 Nov 2026, 2:00 pm, America/Toronto. No network beyond <base-url>. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = process.argv[2] || 'http://localhost:8768/index.html?bare=1';
const OUT = process.argv[3] || 'out';
const ALL = { desktop: { width: 1440, height: 860 }, laptop: { width: 1280, height: 760 }, phone: { width: 390, height: 844 }, small: { width: 360, height: 740 }, check: { width: 1440, height: 900 } };
const SIZES = (process.argv[4] || 'desktop,laptop,phone').split(',').map((n) => [n, ALL[n]]);
const STEP_URL = process.env.STEP_URL || '';
const NOW = new Date('2026-11-13T14:00:00-05:00');
fs.mkdirSync(OUT, { recursive: true });

/* rail = the prototype's review-rail index; step = the build's step name */
const STATES = [
  ['01-welcome', 0, 'welcome'],
  ['02-id-empty', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); }],
  ['02-id-typing', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.typeIn('input[placeholder="CD-YORK-7K42"]', 'cdyork'); }],
  ['02-id-valid', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.typeIn('input[placeholder="CD-YORK-7K42"]', 'cd york 7k42'); }],
  ['02-id-resend', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.click('Can’t find your ID?'); }],
  ['02-id-resend-sent', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.click('Can’t find your ID?'); await a.typeIn('input[type="email"]', 'daniel@yorkcurrency.ca'); await a.click('Send my ID'); }],
  ['03-chapter1', 2, 'chapter1'],
  ['04-signin', 3, 'signin'],
  ['04-signin-passkey', 4, 'signin-passkey'],
  ['04-signin-google', 5, 'signin-google'],
  ['04-signin-cancelled', 6, 'signin-cancelled'],
  ['05-inbox', 7, 'inbox'],
  ['05-inbox-typing', 7, 'inbox', async (a) => { await a.typeIn('input[autocomplete="one-time-code"]', '48'); }],
  ['06-pin-intro', 8, 'pin-intro'],
  ['07-pin', 9, 'pin'],
  ['08-shop-name', 10, 'shop-name'],
  ['09-address', 11, 'address'],
  ['10-shops', 12, 'shops'],
  ['11-shops-more', 13, 'shops-more'],
  ['12-registration', 14, 'registration'],
  ['13-money', 15, 'money'],
  ['14-currencies', 16, 'currencies'],
  ['15-count', 17, 'count'],
  ['15-count-total', 17, 'count', async (a) => { await a.click('Type the total'); }],
  ['16-online', 18, 'online'],
  ['17-rules', 19, 'rules'],
  ['18-officer', 20, 'officer'],
  ['19-idline-law', 21, 'idline'],
  ['19-idline', 21, 'idline', async (a) => { await a.wait(6500); }],
  ['20-team', 22, 'team'],
  ['21-add-person', 23, 'add-person'],
  ['22-confirm', 24, 'confirm'],
  ['23-confirmed', 25, 'confirmed'],
  ['24-pay-plan', 26, 'pay'],
  ['24-pay-extras', 26, 'pay', async (a) => { await a.click('Extras'); }],
  ['24-pay-payment', 26, 'pay', async (a) => { await a.click('Payment'); }],
  ['24-pay-agreement', 26, 'pay', async (a) => { await a.click('The agreement'); }],
  ['25-day1', 27, 'day1', async (a) => { await a.wait(2500); }],
];
/* The welcome tour: motion reference, not pixel baselines. Desktop and phone only. */
const TOUR = [3, 12, 24, 40, 60, 80, 100];
const ONLY_TOUR = !!process.env.ONLY_TOUR;

async function open(name, vp, liveClock) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: vp, timezoneId: 'America/Toronto', locale: 'en-CA' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  if (!liveClock) await p.clock.setFixedTime(NOW); /* the tour runs on its own timers, so it gets a live clock */
  const host = new URL(BASE).host;
  await p.route((u) => new URL(u).host !== host && !(STEP_URL && new URL(u).host === new URL(STEP_URL.replace('{step}', 'x')).host), (r) => r.abort());
  return { b, p, errs };
}

function api(p, name) {
  return {
    p,
    wait: (ms) => p.waitForTimeout(ms),
    click: async (label) => {
      const ok = await p.evaluate((label) => {
        const els = [...document.querySelectorAll('button, a, [role="button"], [role="checkbox"], [role="option"]')]
          .filter((e) => e.offsetParent && !e.closest('[data-review]'));
        const t = (e) => e.innerText.replace(/\s+/g, ' ').trim();
        const hit = els.find((e) => t(e) === label) || els.find((e) => t(e).startsWith(label)) || els.find((e) => t(e).includes(label));
        if (hit) { hit.click(); return true; }
        return false;
      }, label);
      if (!ok) throw new Error('No visible control labelled "' + label + '"');
      await p.waitForTimeout(650);
    },
    fill: async (sel, v) => { const el = p.locator(sel).first(); await el.click(); await el.fill(v); await p.waitForTimeout(350); },
    typeIn: async (sel, v) => { const el = p.locator(sel).first(); await el.click(); await el.type(v, { delay: 40 }); await p.waitForTimeout(500); },
    shot: async (state) => {
      await p.screenshot({ path: path.join(OUT, state + '.' + name + '.png') });
      const spec = await p.evaluate(require('./signup-capture-measure.cjs'));
      fs.writeFileSync(path.join(OUT, state + '.' + name + '.json'), JSON.stringify(spec, null, 1));
      if (spec.pageScrolls && name !== 'phone' && name !== 'small') console.log('  ! page scrolls at', name, 'in', state);
    }
  };
}

async function jump(p, rail, step) {
  if (STEP_URL) { await p.goto(STEP_URL.replace('{step}', step)); await p.waitForTimeout(2500); return; }
  await p.goto(BASE); await p.waitForTimeout(2500);
  await p.evaluate((k) => {
    const bs = [...document.querySelectorAll('[data-review] button')].filter((b) => b.firstElementChild && /^(\d\d)?$/.test((b.firstElementChild.textContent || '').trim()));
    bs[k].click();
  }, rail);
  await p.waitForTimeout(1600);
}

(async () => {
  for (const [name, vp] of SIZES) {
    console.log(name);
    const { b, p, errs } = await open(name, vp);
    const a = api(p, name);
    for (const [state, rail, step, act] of (ONLY_TOUR ? [] : STATES)) {
      try { await jump(p, rail, step); if (act) await act(a); await a.shot(state); }
      catch (e) { console.log('  ! ' + state + ': ' + e.message); process.exitCode=1; }
    }
    if (errs.length) console.log('  ! errors at ' + name + ':', [...new Set(errs)].slice(0, 5));
    await b.close();
    if ((name === 'desktop' || name === 'phone') && !process.env.NO_TOUR) {
      const L = await open(name, vp, true), t2 = api(L.p, name);
      try {
        await jump(L.p, 0, 'welcome');
        await t2.click('Watch the tour');
        let t = 0;
        for (const s of TOUR) { await t2.wait((s - t) * 1000); t = s; await t2.shot('00-tour-' + String(s).padStart(3, '0') + 's'); }
      } catch (e) { console.log('  ! tour: ' + e.message); process.exitCode=1; }
      await L.b.close();
    }
  }
})();
