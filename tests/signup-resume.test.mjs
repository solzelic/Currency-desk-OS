/* Sign-up v2.1, coming back: a reload, a new tab or another browser carries
   on where the owner left off, or says plainly what to do. The bridge files
   run as the page loads them; the prototype's own ORDER and _after are read
   from the frozen design file, not copied. Every ID and name is synthetic. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const drain = () => new Promise(r => setImmediate(r));
const read = f => fs.readFileSync(new URL(`../design/onboarding/${f}`, import.meta.url), 'utf8');
const proto = read('signup-v2.1/CurrencyDesk Sign-up v2.1.dc.html');
const ORDER = JSON.parse(proto.match(/\n {2}ORDER = (\[[\d, ]+\]);/)[1]);
const after = new Function('i', proto.match(/\n {2}_after\(i\) \{ ([^\n]+) \}\n/)[1]).bind({ ORDER });
const ID = 'CD-TEST-2222';

function harness({ stored = {} } = {}) {
  const pending = [], timers = [], assigned = [], store = new Map(Object.entries(stored));
  const sessionStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const context = { window: { addEventListener() {}, innerWidth: 390 }, location: { origin: 'https://example.test', search: '', assign: u => assigned.push(u) },
    history: { replaceState() {} }, sessionStorage, localStorage: { getItem: () => null }, document: { querySelector: () => null },
    fetch: (...args) => new Promise(resolve => pending.push({ args, resolve })), setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    AbortController, URLSearchParams, console, Promise };
  for (const f of ['bridge', 'chapters', 'open']) vm.runInNewContext(read(`signup-v2.1-${f}.js`), context);
  const CD = context.window.__cdOnb;
  /* the prototype's next(), as patched: the bridge first, then ORDER */
  const c = { state: { i: 17, data: {}, landKey: 0 }, _after: after,
    set(k, v) { this.state.data[k] = v; },
    setState(v, cb) { Object.assign(this.state, typeof v === 'function' ? v(this.state) : v); cb?.(); },
    forceUpdate() {}, deviceInfo: () => ({ device: 'synthetic device' }),
    next() { if (CD.beforeNext(this) !== false) this.state.i = after(this.state.i); } };
  CD.comp = c;
  const tick = () => timers.splice(0).forEach(fn => fn());
  const reply = (n, status, body) => pending[n].resolve({ status, json: () => Promise.resolve(body) });
  const paths = () => pending.map(p => `${p.args[1].method} ${p.args[0]}`);
  return { CD, c, pending, reply, tick, paths, store, assigned };
}
const resumed = (lastStep, extra = {}) => ({ lastStep, saved: true, answers: {}, you: {}, pack: null, ...extra });

test('a resume after more shops or a new teammate opens where the prototype’s own Continue went', async () => {
  /* next(): 30 (more shops) goes to 4, 31 (add a person) back to 11; the rest follow ORDER */
  for (const [step, screen] of [['11-shops-more', 4], ['21-add-person', 11], ['10-shops', 4], ['09-address', 29], ['20-team', 13]]) {
    const reload = harness(); reload.CD.code = ID;
    const back = reload.CD.loadResume(false); reload.reply(0, 200, resumed(step)); await back;
    assert.equal(reload.c.state.i, screen, `reload after ${step}`);
    const fresh = harness(); fresh.CD.code = ID;
    const code = fresh.CD.loadResume(true); fresh.reply(0, 200, resumed(step)); await code;
    assert.equal(fresh.CD._resumeTo, screen, `after the email code, ${step}`);
  }
});

test('the signed desk record is headed with the shop’s own reserved address', async () => {
  const h = harness(); h.CD.code = ID;
  const back = h.CD.loadResume(false); h.reply(0, 200, resumed('20-team', { workspace: 'harbour-synthetic' })); await back;
  assert.equal(h.c.state.data.workspace, 'harbour-synthetic');
});

test('a new tab in the same browser carries on from the ID instead of asking for a sign-in again', async () => {
  const h = harness(); h.c.state.i = 0;
  h.CD.checkRef(ID, () => {}); h.tick();
  h.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'reserved', signup: 'verified', lastStep: '08-shop-name' }); await drain();
  h.c.next();
  assert.deepEqual(h.paths(), [`GET /api/onboarding/${ID}/state`, `GET /api/onboarding/${ID}/resume`]);
  h.reply(1, 200, resumed('08-shop-name')); await drain(); await drain();
  assert.equal(h.c.state.i, 3);
  /* an enrolment that lapsed in between: the ID goes on to chapter 1, never a dead button */
  const lapsed = harness(); lapsed.c.state.i = 0;
  lapsed.CD.checkRef(ID, () => {}); lapsed.tick();
  lapsed.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'reserved', signup: 'verified' }); await drain();
  lapsed.c.next(); lapsed.reply(1, 401, { error: 'sign_in_again' }); await drain(); await drain();
  assert.equal(lapsed.c.state.i, 20);
  /* no enrolment in this browser: chapter 1, as before, and nothing more is asked */
  const plain = harness(); plain.c.state.i = 0;
  plain.CD.checkRef(ID, () => {}); plain.tick();
  plain.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'reserved' }); await drain();
  plain.c.next();
  assert.equal(plain.c.state.i, 20); assert.equal(plain.pending.length, 1);
});

test('another browser is told where its sign-in is, not to carry on from nowhere', async () => {
  const refused = { error: 'already_verified', detail: 'Your sign-in is already set. Carry on where you left off.' };
  const h = harness(); h.CD.code = ID; h.c.state.i = 5;
  h.c.state.data = { ownerPass: 'four plain synthetic words', pass2: 'four plain synthetic words' };
  const saved = h.CD.password(h.c); h.reply(0, 409, refused); await saved;
  assert.match(h.c.state.lockErr, /browser where you chose it/);
  assert.match(h.c.state.lockErr, /isn’t ready yet/);
  const pk = harness(); pk.CD.code = ID; pk.c.state.i = 5;
  pk.CD.passkey(pk.c); pk.reply(0, 409, refused); await drain(); await drain();
  assert.match(pk.c.state.lockErr, /browser where you chose it/);
  const sso = harness(); sso.CD.code = ID; sso.c.state.i = 5;
  sso.CD.sso(sso.c, 'google'); sso.reply(0, 409, refused); await drain(); await drain();
  assert.match(sso.c.state.lockErr, /browser where you chose it/);
});

test('an open desk this browser paid for is handed over by /open, never sent to sign in', async () => {
  const reload = harness({ stored: { cdSignupId: ID } }); reload.CD.mount(reload.c);
  reload.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'active', signup: 'active' }); await drain();
  assert.deepEqual(reload.paths(), [`GET /api/onboarding/${ID}/state`, `POST /api/onboarding/${ID}/open`]);
  assert.equal(reload.c.state.i, 15); assert.equal(reload.CD._paying, true);
  reload.reply(1, 200, { ok: true, tenantId: 'tnt-synthetic', cdId: ID }); await drain();
  assert.equal(reload.CD.launched, true); assert.deepEqual(reload.assigned, []);
  /* typed in a new tab of the same browser: Open it hands over too */
  const tab = harness(); tab.c.state.i = 0;
  tab.CD.checkRef(ID, () => {}); tab.tick();
  tab.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'active', signup: 'active' }); await drain();
  tab.c.next();
  assert.equal(tab.paths()[1], `POST /api/onboarding/${ID}/open`); assert.deepEqual(tab.assigned, []);
  /* no enrolment in this browser: sign in, as before */
  const other = harness(); other.c.state.i = 0;
  other.CD.checkRef(ID, () => {}); other.tick();
  other.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'active' }); await drain();
  other.c.next();
  assert.deepEqual(other.assigned, ['/login']); assert.equal(other.pending.length, 1);
});

test('an open desk whose hand-off is spent goes to sign in rather than a plan it cannot pay', async () => {
  const h = harness({ stored: { cdSignupId: ID } }); h.CD.mount(h.c);
  h.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'active', signup: 'active' }); await drain();
  assert.equal(h.paths()[1], `POST /api/onboarding/${ID}/open`);
  h.reply(1, 401, { error: 'sign_in_again' }); await drain();
  assert.equal(h.c.state.i, 0); assert.equal(h.CD._paying, false); assert.equal(h.CD.err, 'This desk is already open. Sign in.');
  h.c.next(); assert.deepEqual(h.assigned, ['/login']);
});

test('after the page stops waiting for the desk, Check again asks /open again', async () => {
  const h = harness(); h.CD.code = ID; h.c.state.i = 15; h.CD._paying = true;
  h.CD.waitOpen(h.c, 0);
  const opens = () => h.pending.filter(p => p.args[0].endsWith('/open'));
  for (let n = 0; n <= 60; n++) { h.reply(h.pending.length - 1, 202, { pending: true }); await drain(); h.tick(); }
  assert.equal(opens().length, 61); assert.equal(h.CD._paying, false);
  assert.match(h.CD.payErr, /Check again/);
  const R = h.CD.priced(h.c, {});
  assert.equal(R.checkOpenVisible, true);
  R.onCheckOpen();
  assert.equal(opens().length, 62); assert.equal(h.CD._paying, true);
  assert.equal(h.CD.priced(h.c, {}).checkOpenVisible, false);
  h.reply(h.pending.indexOf(opens()[61]), 200, { ok: true, tenantId: 'tnt-synthetic', cdId: ID }); await drain();
  assert.equal(h.CD.launched, true);
});

test('a reload on Check your inbox lands back on it; the flag is not personal and goes once the code is in', async () => {
  const h = harness({ stored: { cdSignupId: ID } }); h.CD.code = ID; h.c.state.i = 5;
  h.c.state.data = { ownerPass: 'four plain synthetic words', pass2: 'four plain synthetic words' };
  const saved = h.CD.password(h.c); h.reply(0, 200, { ok: true, codeSent: true }); await saved;
  const kept = Object.fromEntries(h.store);
  assert.deepEqual(Object.keys(kept).sort(), ['cdSignupId', 'cdSignupInbox']); assert.equal(kept.cdSignupInbox, '1');
  const reload = harness({ stored: kept }); reload.CD.mount(reload.c);
  reload.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'reserved' }); await drain();
  assert.equal(reload.c.state.i, 14);
  const ok = reload.CD.checkCode('482913'); reload.reply(1, 200, { ok: true }); await drain();
  reload.reply(2, 200, { lastStep: '06-pin-intro', saved: false, answers: {}, you: {} }); await ok;
  assert.deepEqual([...reload.store.keys()], ['cdSignupId']);
  /* without the flag a reload starts at the ID, as before */
  const plain = harness({ stored: { cdSignupId: ID } }); plain.CD.mount(plain.c);
  plain.reply(0, 200, { valid: true, operatingName: 'Synthetic Exchange', state: 'reserved' }); await drain();
  assert.equal(plain.c.state.i, 0);
});
