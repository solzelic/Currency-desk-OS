/* Sign-up v2.1 on staging, in the browser: the code the server hands back for
   the staging door's synthetic shop only (bridge), the no-card Open (open),
   and Start on Day 1's landing at #day1 (bridge mount, open). Nothing here
   decides whether a shop is the fixture: the server does, and a body without
   its field changes nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const drain = () => new Promise(r => setImmediate(r));
const read = f => fs.readFileSync(new URL(`../design/onboarding/signup-v2.1-${f}.js`, import.meta.url), 'utf8');

function bridge() {
  const pending = [];
  const context = { window: { addEventListener() {} }, location: { origin: 'https://example.test' }, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    fetch: (...args) => new Promise(resolve => pending.push({ args, resolve })), setTimeout: () => 0, clearTimeout() {}, AbortController, URLSearchParams, console };
  vm.runInNewContext(read('bridge'), context);
  const CD = context.window.__cdOnb;
  const c = { state: { i: 5, data: { ownerPass: 'four plain words here', pass2: 'four plain words here' } }, set(k, v) { this.state.data[k] = v; }, setState(v) { Object.assign(this.state, v); }, forceUpdate() {} };
  CD.comp = c; CD.code = 'CD-HARB-2345';
  const reply = (n, status, body) => pending[n].resolve({ status, json: () => Promise.resolve(body) });
  return { CD, c, pending, reply };
}

test('the built page words the inbox for a staging code only when one is shown', () => {
  const page = fs.readFileSync(new URL('../web/app/signup.js', import.meta.url), 'utf8');
  assert.match(page, /window\.__cdOnb\.verify\.code \? 'Staging test shop: no email is sent\. Your 6-digit code is below\.' : 'We just sent a 6-digit code/);
});

test('a staging code from the credential reply fills the frozen Staging code row; an ordinary reply leaves it empty', async () => {
  const h = bridge();
  const saved = h.CD.password(h.c); h.reply(0, 200, { ok: true, kind: 'password', codeSent: true, stagingCode: '048213' }); await saved;
  assert.equal(h.CD.verify.code, '048213');
  const plain = bridge();
  const p = plain.CD.password(plain.c); plain.reply(0, 200, { ok: true, kind: 'password', codeSent: true }); await p;
  assert.equal(plain.CD.verify.code, '');
});

test('a malformed staging code is never shown', async () => {
  for (const bad of ['12345', '1234567', 'abcdef', 123456, null]) {
    const h = bridge(); const p = h.CD.password(h.c); h.reply(0, 200, { ok: true, codeSent: true, stagingCode: bad }); await p;
    assert.equal(h.CD.verify.code, '');
  }
});

test('a late reply for another ID cannot show its code here', async () => {
  const h = bridge(); const p = h.CD.password(h.c);
  h.CD.code = 'CD-NEXT-6789';
  h.reply(0, 200, { ok: true, codeSent: true, stagingCode: '048213' }); await p;
  assert.equal(h.CD.verify.code, '');
});

test('resend replaces the shown code; a spent code brings Send it again back; success clears it', async () => {
  const h = bridge(); h.CD.verify.code = '111111';
  const sent = h.CD.sendCode(); h.reply(0, 200, { ok: true, sent: true, stagingCode: '222222' }); await sent;
  assert.equal(h.CD.verify.code, '222222');
  const wrong = h.CD.checkCode('999999'); h.reply(1, 401, { error: 'wrong_code', detail: 'nope' }); await wrong;
  assert.equal(h.CD.verify.code, '222222');
  const lapsed = h.CD.checkCode('222222'); h.reply(2, 410, { error: 'expired', detail: 'expired' }); await lapsed;
  assert.equal(h.CD.verify.code, '');
  h.CD.verify.code = '333333';
  const ok = h.CD.checkCode('333333'); h.reply(3, 200, { ok: true }); await drain();
  assert.equal(h.CD.verify.code, '');
  void ok;
});

function open() {
  const requests = [], pending = [], confirms = [];
  const box = { textContent: '', attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; } };
  const stripe = { elements: () => { throw Error('Stripe must not load for a staging shop'); }, confirmSetup: a => { confirms.push(a); return Promise.resolve({}); } };
  const CD = { h: { api: (method, path, body) => { requests.push({ method, path, body }); return new Promise(resolve => pending.push(resolve)); }, why: (r, f) => r.body.detail || f, NET: 'Offline', tabSet() {} } };
  const context = { window: { addEventListener() {}, __cdOnb: CD, Stripe: () => stripe, __cdAgreementHash: 'pinned-version' }, document: { querySelector: s => s === '[data-stripe-card]' ? box : null }, location: { origin: 'https://example.test' }, setTimeout: fn => { fn(); return 0; }, clearTimeout() {}, console, Promise };
  vm.runInNewContext(read('open'), context);
  CD.code = 'CD-HARB-2345';
  const c = { state: { termsRead: true, i: 15, landKey: 0, data: { plan: 'ai', term: 'monthly', addons: {} } }, forceUpdate() {}, set() {}, setState(v) { Object.assign(this.state, v); }, locCount: () => 1 };
  return { CD, c, requests, pending, confirms, box };
}

test('a staging plan reply shows the no-card note and loads no card form', async () => {
  const h = open(); h.CD.card(h.c);
  h.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'pinned-version', price: {} } }); await drain();
  assert.equal(h.CD._staging, true); assert.equal(h.CD.cardComplete, true); assert.equal(h.CD._elements, null);
  assert.match(h.box.textContent, /No card is taken, nothing on this form is sent and nothing is charged/);
  /* every render asks for the card again: a prepared staging plan is not asked twice */
  h.CD.card(h.c); h.CD.card(h.c);
  assert.equal(h.requests.length, 1);
  h.c.state.data.term = 'annual'; h.CD.card(h.c);
  assert.equal(h.requests.length, 2); assert.equal(h.CD._staging, false);
});

test('a staging reply for another agreement version is refused', async () => {
  const h = open(); h.CD.card(h.c);
  h.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'other', price: {} } }); await drain();
  assert.notEqual(h.CD._staging, true); assert.equal(h.CD.cardComplete, false); assert.ok(h.CD.payErr);
});

test('Open on a staging shop asks staging-open with the pinned version, never the card agreement or Stripe, then the session', async () => {
  const h = open(); h.CD.card(h.c);
  h.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'pinned-version', price: {} } }); await drain();
  h.CD.pay(h.c); await drain();
  assert.equal(h.requests[1].path, '/staging-open');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].body)), { termsSourceHash: 'pinned-version', agreed: true });
  h.pending[1]({ status: 409, body: { error: 'already_open' } }); await drain();
  assert.equal(h.requests[2].path, '/open');
  assert.equal(h.requests.some(r => r.path === '/agreement'), false); assert.equal(h.confirms.length, 0);
});

test('a refused staging Open re-prepares and says why; a changed plan sends nothing', async () => {
  const h = open(); h.CD.card(h.c);
  h.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'pinned-version', price: {} } }); await drain();
  h.CD.pay(h.c); h.pending[1]({ status: 409, body: { error: 'agreement_changed', detail: 'Review it again' } }); await drain();
  assert.equal(h.CD._paying, false); assert.equal(h.CD.payErr, 'Review it again'); assert.equal(h.CD._staging, false); assert.equal(h.CD.cardComplete, false);
  const g = open(); g.CD.card(g.c);
  g.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'pinned-version', price: {} } }); await drain();
  g.c.state.data.term = 'annual'; g.CD.pay(g.c); await drain();
  assert.equal(g.requests.length, 1);
});

/* ---- Start on Day 1 (POST /api/staging/day-one) ------------------------- */
const DAY = { cdId: 'CD-STAG-2345', email: 'owner+1a2b3c4d@staging.invalid', password: 'k7m2p-x9q4r-h3n8', pin: '4821' };
const dayReply = (over = {}) => ({ ok: true, cdId: DAY.cdId, operatingName: 'Staging Shop 1A2B', signIn: { email: DAY.email, password: DAY.password, pin: DAY.pin }, ...over });

/* The page as it loads at /onboarding#day1: bridge, chapters and open, then mount. */
function landing({ hash = '#day1', flag = 'fresh', stored = {} } = {}) {
  const pending = [], timers = [], replaced = [], sets = [], removed = [], local = [], listeners = {};
  const store = new Map(Object.entries(stored));
  if (flag === 'fresh') store.set('cdDayOne', String(Date.now() - 2000));
  if (flag === 'stale') store.set('cdDayOne', String(Date.now() - 61000));
  if (flag === 'future') store.set('cdDayOne', String(Date.now() + 61000));
  if (flag === 'junk') store.set('cdDayOne', 'yes');
  const sessionStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { sets.push([k, String(v)]); store.set(k, String(v)); }, removeItem: k => { removed.push(k); store.delete(k); } };
  const localStorage = { getItem: () => null, setItem: (k, v) => local.push([k, v]), removeItem: k => local.push([k]) };
  const node = { style: {} }, frame = { contentWindow: {} };
  const context = {
    window: { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }, innerWidth: 1280, __cdAgreementHash: 'pinned-version' },
    location: { origin: 'https://staging.currencydeskos.com', pathname: '/onboarding', search: '', hash, assign() {} },
    history: { replaceState: (_s, _t, url) => replaced.push(url) }, sessionStorage, localStorage,
    document: { querySelector: s => s === '[data-staging-day-one]' ? node : s === 'iframe[data-real-home]' ? frame : null },
    fetch: (...args) => new Promise(resolve => pending.push({ args, resolve })),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, AbortController, URLSearchParams, console, Promise,
  };
  for (const f of ['bridge', 'chapters', 'open']) vm.runInNewContext(read(f), context);
  const CD = context.window.__cdOnb;
  /* every screen the page moves to, with the shop name it then has: the
     prototype draws its stand-in shop on a shop screen with no name */
  const shown = [];
  const c = { state: { i: 17, data: {}, landKey: 0 }, _after: i => i, JURIS: [],
    set(k, v) { this.state.data[k] = v; },
    setState(v, cb) { const p = typeof v === 'function' ? v(this.state) : v; Object.assign(this.state, p); if ('i' in p) shown.push({ i: p.i, name: this.state.data.operatingName || '' }); cb?.(); },
    forceUpdate() {} };
  CD.mount(c);
  const reply = (n, status, body) => pending[n].resolve({ status, json: () => Promise.resolve(body) });
  const paths = () => pending.map(p => `${p.args[1].method} ${p.args[0]}`);
  const tick = () => timers.splice(0).forEach(fn => fn());
  const fire = (type, e = {}) => (listeners[type] || []).forEach(fn => fn(e));
  return { CD, c, pending, reply, paths, tick, replaced, sets, removed, local, store, fire, node, frame, shown };
}
/* What Day 1's welcome draws, from the bridge's own render values over the
   prototype's (its sentence, its button, its confetti). */
const PROTO = { dkSub: 'Staging Shop 1A2B is open. You’re a Founding Operator.', dkCta: 'Build my desk →', dkConf: ['piece'] };
const cardOf = h => {
  const R = h.CD.priced(h.c, { ...PROTO });
  return { i: h.c.state.i, waiting: R.dkWaiting === true, sub: R.dkSub, cta: R.dkCta, confetti: R.dkConf.length, status: R.homeStatus,
    check: R.dayOneCheckVisible === true, prototype: R.prototypeHome, real: R.realHome };
};
const SIGNING = 'Signing up a new staging test shop and opening its desk. This takes a few seconds.';
const WAITING = { i: 16, waiting: true, sub: SIGNING, cta: 'Opening your desk…', confetti: 0, status: '', check: false, prototype: false, real: false };
const NAMED = { ...WAITING, sub: 'Opening Staging Shop 1A2B. This takes a few seconds.' };
const resumedDay = { state: 'verified', lastStep: '20-team', saved: true, pinSet: true, answers: { operatingName: 'Staging Shop 1A2B' }, you: { name: 'Staging Owner' }, pack: null, callPreference: { call: false } };
/* A whole Day 1 landing, through /open and the one-second step to screen 16. */
async function landed(stagingOpen = [200, { ok: true }]) {
  const h = landing();
  h.reply(0, 201, dayReply()); await drain();
  h.reply(1, 200, resumedDay); await drain(); await drain();
  h.reply(2, stagingOpen[0], stagingOpen[1]); await drain();
  h.reply(3, 200, { ok: true, tenantId: 'tnt-synthetic', cdId: DAY.cdId, operatingName: 'Staging Shop 1A2B' }); await drain();
  h.tick();
  return h;
}

test('Start on Day 1: the click’s own tab goes straight to Day 1’s welcome, posts once, then the page’s existing resume, staging-open and open', async () => {
  const h = landing();
  assert.deepEqual(h.replaced, ['/onboarding']);
  assert.ok(h.removed.includes('cdDayOne')); assert.equal(h.store.has('cdDayOne'), false);
  assert.deepEqual(h.paths(), ['POST /api/staging/day-one']);
  assert.equal(h.pending[0].args[1].headers['content-type'], 'application/json');
  assert.equal(h.pending[0].args[1].body, '{}');
  /* the press lands on Day 1 at once: its welcome says the shop is opening and
     Build my desk waits; no prototype desk behind it, no confetti yet */
  assert.equal(h.CD._paying, true);
  assert.deepEqual(cardOf(h), WAITING);
  h.reply(0, 201, dayReply()); await drain();
  assert.deepEqual(h.paths().slice(1), [`GET /api/onboarding/${DAY.cdId}/resume`]);
  /* the server has named the shop: the welcome says which */
  assert.deepEqual(cardOf(h), NAMED);
  /* nothing in this tab names the reservation until the desk is opening */
  assert.equal(h.store.get('cdSignupId'), undefined);
  h.reply(1, 200, resumedDay); await drain(); await drain();
  assert.equal(h.paths()[2], `POST /api/onboarding/${DAY.cdId}/staging-open`);
  assert.deepEqual(JSON.parse(h.pending[2].args[1].body), { termsSourceHash: 'pinned-version', agreed: true });
  h.reply(2, 200, { ok: true }); await drain();
  assert.equal(h.store.get('cdSignupId'), DAY.cdId);
  assert.equal(h.paths()[3], `POST /api/onboarding/${DAY.cdId}/open`);
  /* still Day 1 while /open answers: never the plan screen, its landing or its card */
  assert.deepEqual(cardOf(h), NAMED);
  h.reply(3, 200, { ok: true, tenantId: 'tnt-synthetic', cdId: DAY.cdId, operatingName: 'Staging Shop 1A2B' }); await drain();
  assert.equal(h.CD.launched, true); assert.equal(h.store.get('cdSignupId'), undefined);
  /* open: the welcome says so (the prototype's own sentence), the confetti
     plays, Build my desk works, and the real Home is behind it */
  assert.deepEqual(cardOf(h), { i: 16, waiting: false, sub: PROTO.dkSub, cta: PROTO.dkCta, confetti: 1, status: 'Loading your desk…', check: false, prototype: false, real: true });
  assert.equal(h.CD.holding(), false);
  h.tick();
  assert.equal(h.c.state.i, 16);
  assert.equal(h.paths().filter(p => p === 'POST /api/staging/day-one').length, 1);
  /* only ever Day 1: no screen before it and none in between */
  assert.ok(h.shown.length >= 1 && h.shown.every(s => s.i === 16), JSON.stringify(h.shown));
  /* the one staging line, on Day 1 only */
  const line = h.CD.priced(h.c, {}).stagingDayOne;
  assert.match(line, /Counter PIN 4821/);
  assert.match(line, /0000/);
  assert.ok(line.includes(DAY.email)); assert.ok(line.includes(DAY.password));
  assert.match(line, /CD-221/); assert.match(line, /12 hours/);
  assert.match(line, /not shown again/);
  assert.doesNotMatch(line, /[–—]/);
  h.c.state.i = 15; assert.equal(h.CD.priced(h.c, {}).stagingDayOne || '', '');
  /* storage: only the ID in this tab, never a secret; nothing in localStorage */
  assert.deepEqual(h.sets.map(([k]) => k), ['cdSignupId']);
  for (const [, v] of h.sets) for (const secret of [DAY.pin, DAY.password, DAY.email]) assert.ok(!v.includes(secret));
  assert.deepEqual(h.local, []);
});

test('#day1 without this tab’s fresh mark is inert: no POST, the address is tidied and the page mounts as usual', async () => {
  for (const flag of [null, 'stale', 'future', 'junk']) {
    const h = landing({ flag });
    assert.deepEqual(h.replaced, ['/onboarding'], String(flag));
    assert.deepEqual(h.paths(), [], String(flag));
    assert.equal(h.store.has('cdDayOne'), false);
    assert.equal(h.c.state.i, 17);
  }
  /* a mark without #day1 does nothing either, and is dropped */
  const h = landing({ hash: '' });
  assert.deepEqual(h.paths(), []); assert.deepEqual(h.replaced, []); assert.equal(h.store.has('cdDayOne'), false);
  /* an ordinary returning tab still resumes its own reservation */
  const own = landing({ hash: '', flag: null, stored: { cdSignupId: 'CD-HARB-2345' } });
  assert.deepEqual(own.paths(), ['GET /api/onboarding/CD-HARB-2345/state']);
});

test('a malformed or refused Day 1 reply shows no line, never opens, and lands on the ID screen with the reason', async () => {
  const bad = [
    [201, dayReply({ cdId: 'CD-stag-2345' })],
    [201, dayReply({ cdId: undefined })],
    [201, dayReply({ signIn: { email: 'someone@example.com', password: DAY.password, pin: DAY.pin } })],
    [201, dayReply({ signIn: { email: DAY.email, password: DAY.password, pin: '48210' } })],
    [201, dayReply({ signIn: { email: DAY.email, password: 'short', pin: DAY.pin } })],
    [201, dayReply({ signIn: undefined })],
    /* no name: the plan screen would fall back to the prototype's stand-in shop */
    [201, dayReply({ operatingName: undefined })],
    [201, dayReply({ operatingName: '  ' })],
    [201, dayReply({ operatingName: 42 })],
    [200, dayReply()],
    [404, { error: 'not_found' }],
    [429, { error: 'slow_down' }],
    [503, { error: 'staging_unavailable', detail: 'This staging door can’t open a shop just now. No desk was opened.' }],
    [0, { error: 'network', detail: 'offline' }],
  ];
  for (const [status, body] of bad) {
    const h = landing();
    h.reply(0, status, body); await drain(); await drain();
    const label = `${status} ${JSON.stringify(body)}`;
    assert.deepEqual(h.paths(), ['POST /api/staging/day-one'], label);
    assert.equal(h.c.state.i, 0, label);
    assert.equal(h.CD._paying, false, label);
    assert.ok(h.CD.err, label);
    if (body.detail) assert.equal(h.CD.err, body.detail, label);
    assert.equal(h.CD.priced(h.c, {}).stagingDayOne || '', '', label);
    assert.equal(h.store.get('cdSignupId'), undefined, label);
    assert.equal(h.CD.code, '', label);
    /* from Day 1's welcome to the ID screen with the reason, which can be used */
    assert.equal(h.CD.holding(), false, label);
    assert.deepEqual(h.shown, [{ i: 16, name: '' }, { i: 0, name: '' }], label);
  }
});

test('while the press answers, nothing moves the page off Day 1', () => {
  const h = landing();
  assert.equal(h.CD.holding(), true);
  /* Continue, the skips and Back (the build patches back() to ask holding() first) */
  assert.equal(h.CD.beforeNext(h.c), false);
  assert.equal(h.CD.beforeGo(h.c, 13), false);
  assert.deepEqual(h.shown, [{ i: 16, name: '' }]);
  assert.equal(h.c.state.i, 16);
});

test('a 201 is never dropped: whatever moved meanwhile, the new shop opens in this tab', async () => {
  const h = landing();
  /* as a navigation that slipped past holding() would: the old page dropped the 201 here and stranded the tab */
  h.CD.navigation();
  h.reply(0, 201, dayReply()); await drain();
  assert.deepEqual(h.paths().slice(1), [`GET /api/onboarding/${DAY.cdId}/resume`]);
  h.reply(1, 200, resumedDay); await drain(); await drain();
  h.reply(2, 200, { ok: true }); await drain();
  h.reply(3, 200, { ok: true, tenantId: 'tnt-synthetic', cdId: DAY.cdId, operatingName: 'Staging Shop 1A2B' }); await drain();
  h.tick();
  assert.equal(h.CD.launched, true); assert.equal(h.c.state.i, 16);
  assert.match(h.CD.priced(h.c, {}).stagingDayOne, /4821/);
});

/* Day 1 up to /open, which is left unanswered (pending[3]) */
async function toOpen() {
  const h = landing();
  h.reply(0, 201, dayReply()); await drain();
  h.reply(1, 200, resumedDay); await drain(); await drain();
  h.reply(2, 200, { ok: true }); await drain();
  return h;
}

test('an /open that refuses keeps Day 1’s welcome, says why there and offers Check again, which opens it', async () => {
  const h = await toOpen();
  h.reply(3, 500, { error: 'server', detail: 'The desk didn’t open. Nothing was charged.' }); await drain();
  assert.equal(h.CD.launched, false); assert.equal(h.CD.code, DAY.cdId);
  assert.deepEqual(cardOf(h), { ...NAMED, status: 'The desk didn’t open. Nothing was charged.', check: true });
  assert.equal(h.CD.payErr || '', '');
  assert.equal(h.CD.priced(h.c, {}).stagingDayOne || '', '');
  assert.ok(h.shown.every(s => s.i === 16), JSON.stringify(h.shown));
  /* a reply without a reason gets the page's own */
  const q = await toOpen();
  q.reply(3, 500, {}); await drain();
  assert.equal(cardOf(q).status, 'The desk didn’t open. Check again in a minute.');
  /* Check again: the same /open, once more, and the welcome waits again */
  h.CD.priced(h.c, { ...PROTO }).onDayOneCheck();
  assert.equal(h.paths()[4], `POST /api/onboarding/${DAY.cdId}/open`);
  assert.deepEqual(cardOf(h), NAMED);
  h.reply(4, 200, { ok: true, tenantId: 'tnt-synthetic', cdId: DAY.cdId, operatingName: 'Staging Shop 1A2B' }); await drain();
  assert.equal(h.CD.launched, true); assert.equal(cardOf(h).cta, PROTO.dkCta);
  assert.match(h.CD.priced(h.c, {}).stagingDayOne, /4821/);
});

test('an /open still pending says so on Day 1 after ten tries, never a card; after sixty it offers Check again', async () => {
  const h = await toOpen();
  for (let n = 0; n <= 60; n++) {
    h.reply(3 + n, 202, { ok: false, opening: true }); await drain();
    if (n === 9) assert.equal(cardOf(h).status, '', 'quiet for the first ten');
    if (n === 10) assert.deepEqual(cardOf(h), { ...NAMED, status: 'Still opening the desk. This can take a minute. Stay on this page.' });
    if (n < 60) h.tick();
  }
  assert.equal(h.paths().filter(p => p.endsWith('/open')).length, 61);
  assert.deepEqual(cardOf(h), { ...NAMED, status: 'The desk hasn’t opened yet. Check again in a minute.', check: true });
  assert.equal(h.CD.payErr || '', '');
  assert.doesNotMatch(JSON.stringify(cardOf(h)), /card/i);
  /* a dropped connection (status 0) is waited out the same way */
  const z = await toOpen();
  z.reply(3, 0, { error: 'network' }); await drain();
  assert.equal(z.pending.length, 4); z.tick();
  assert.equal(z.paths()[4], `POST /api/onboarding/${DAY.cdId}/open`);
  assert.deepEqual(cardOf(z), NAMED);
});

test('the real Home stays hidden behind the welcome until it has drawn itself, never showing the sign-in it starts on', async () => {
  const h = await landed();
  assert.equal(h.CD.priced(h.c, {}).homeOpacity, '0');
  /* another frame's or another shop's message changes nothing */
  h.fire('message', { origin: 'https://staging.currencydeskos.com', source: {}, data: { type: 'cd-signup-home-ready', tenantId: 'tnt-synthetic' } });
  h.fire('message', { origin: 'https://staging.currencydeskos.com', source: h.frame.contentWindow, data: { type: 'cd-signup-home-ready', tenantId: 'tnt-other' } });
  assert.equal(h.CD.priced(h.c, {}).homeOpacity, '0');
  h.fire('message', { origin: 'https://staging.currencydeskos.com', source: h.frame.contentWindow, data: { type: 'cd-signup-home-ready', tenantId: 'tnt-synthetic' } });
  assert.equal(h.CD.priced(h.c, {}).homeOpacity, '1');
  assert.equal(h.CD.priced(h.c, {}).homeStatus, '');
});

test('a refused resume or staging-open stops before /open and says why', async () => {
  const r = landing();
  r.reply(0, 201, dayReply()); await drain();
  r.reply(1, 401, { error: 'sign_in_again', detail: 'For your security, sign in again to carry on.' }); await drain(); await drain();
  assert.equal(r.pending.length, 2); assert.equal(r.c.state.i, 0); assert.equal(r.CD.err, 'For your security, sign in again to carry on.');
  const o = landing();
  o.reply(0, 201, dayReply()); await drain();
  o.reply(1, 200, resumedDay); await drain(); await drain();
  o.reply(2, 409, { error: 'agreement_changed', detail: 'Your desk or plan changed.' }); await drain();
  assert.equal(o.pending.length, 3); assert.equal(o.c.state.i, 0); assert.equal(o.CD.err, 'Your desk or plan changed.');
  assert.equal(o.store.get('cdSignupId'), undefined);
  assert.equal(o.CD.priced(o.c, {}).stagingDayOne || '', '');
});

test('an ordinary launch never draws the staging line; leaving Day 1 forgets it', async () => {
  const plain = landing({ hash: '', flag: null });
  plain.CD.launched = true; plain.c.state.i = 16;
  assert.equal(plain.CD.priced(plain.c, {}).stagingDayOne || '', '');
  const h = await landed();
  assert.match(h.CD.priced(h.c, {}).stagingDayOne, /4821/);
  h.fire('pagehide');
  assert.equal(h.CD.priced(h.c, {}).stagingDayOne || '', '');
  assert.equal(h.node.style.display, 'none');
  /* staging-open answering already open carries on the same way */
  const w = await landed([409, { error: 'already_open' }]);
  assert.match(w.CD.priced(w.c, {}).stagingDayOne, /4821/);
  w.CD.walk();
  assert.equal(w.CD.priced(w.c, {}).stagingDayOne || '', '');
});

test('the built page draws the staging Day 1 line once, only when it is set', () => {
  const page = fs.readFileSync(new URL('../web/app/signup.js', import.meta.url), 'utf8');
  assert.equal(page.split('"data-staging-day-one":"true"').length - 1, 1);
  assert.match(page, /v\?\.\["stagingDayOne"\] \?/);
});

test('the built page has no hold: Build my desk waits on dkWaiting, the welcome speaks its sentence, Check again is drawn, the real Home fades in', () => {
  const page = fs.readFileSync(new URL('../web/app/signup.js', import.meta.url), 'utf8');
  assert.equal(page.includes('data-staging-day-one-hold'), false);
  assert.equal(page.includes('holdInert'), false);
  assert.equal(page.includes('Signing up a new test shop and opening its desk. This takes a few seconds.'), false);
  assert.equal(page.split('"disabled":v?.["dkWaiting"],"aria-busy":v?.["dkWaiting"],"data-build-my-desk":"true","style":style((v?.["dkCtaLook"] ?? "") + "width: 100%;').length - 1, 1);
  assert.equal(page.split('"role":"status","aria-live":"polite","style":style("font-size: 15px; color: #6B6459;').length - 1, 1);
  assert.match(page, /v\?\.\["dayOneCheckVisible"\] \?/);
  assert.equal(page.split('"onClick":v?.["onDayOneCheck"]').length - 1, 1);
  assert.equal(page.split('opacity:" + (v?.["homeOpacity"] ?? "") + ";transition:opacity 0.45s ease;"').length - 1, 1);
  assert.equal(page.split('back() { if (window.__cdOnb.holding()) return; window.__cdOnb.navigation();').length - 1, 1);
});

/* ---- a staging Open (no card) waits without card words -------------------- */
test('a staging Open that is slow or stalls never says a card was saved', async () => {
  const h = open(); h.CD.card(h.c);
  h.pending[0]({ status: 200, body: { ok: true, staging: true, termsSourceHash: 'pinned-version', price: {} } }); await drain();
  h.CD.pay(h.c); await drain();
  h.pending[1]({ status: 200, body: { ok: true } }); await drain();
  /* this harness runs every timer at once: answer each /open in turn */
  for (let n = 0; n <= 60; n++) {
    h.pending[2 + n]({ status: 202, body: { ok: false } }); await drain();
    if (n === 10) assert.equal(h.CD.payErr, 'The desk is still opening; this can take a minute. Stay on this page.');
  }
  assert.match(h.CD.payErr, /^Nothing was charged, but the desk hasn’t opened yet\. Check again in a minute\./);
  assert.doesNotMatch(h.CD.payErr, /card/i);
  assert.ok(h.CD._openStalled);
});
