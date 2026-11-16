/* Sign-up v2.1 on staging, in the browser: the code the server hands back for
   the staging door's synthetic shop only (bridge), and the no-card Open
   (open). Nothing here decides whether a shop is the fixture: the server does,
   and a body without its field changes nothing. */
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
