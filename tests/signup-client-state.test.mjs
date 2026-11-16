import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const drain = () => new Promise(r => setImmediate(r));
function harness() {
  const pending = [], timers = new Map(); let seq = 0;
  const context = { window: { addEventListener() {} }, location: { origin: 'https://example.test' }, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} }, fetch: (...args) => new Promise(resolve => pending.push({ args, resolve })), setTimeout: fn => { timers.set(++seq, fn); return seq; }, clearTimeout: id => timers.delete(id), AbortController, URLSearchParams, console };
  for (const file of ['bridge', 'chapters']) vm.runInNewContext(fs.readFileSync(new URL(`../design/onboarding/signup-v2.1-${file}.js`, import.meta.url), 'utf8'), context);
  const CD = context.window.__cdOnb;
  const c = { state: { i: 0, data: {} }, set(k,v) { this.state.data[k] = v; }, setState(v, cb) { Object.assign(this.state, typeof v === 'function' ? v(this.state) : v); cb?.(); }, forceUpdate() {}, next() { this.state.i++; }, locCount() { return this.state.data.shopCount || 1; }, jurisOf: () => ({ home: 'CAD' }) };
  CD.comp = c;
  const tick = () => { const all = [...timers.values()]; timers.clear(); all.forEach(fn => fn()); };
  const reply = (n, status, body) => pending[n].resolve({ status, json: () => Promise.resolve(body) });
  return { CD, c, pending, tick, reply };
}
test('a stale active ID response cannot select a different reservation or redirect its owner', async () => {
  const h = harness(); h.CD.checkRef('CD-FIRS-2222', () => {}); h.tick();
  h.CD.checkRef('CD-NEXT-3333', () => {}); h.tick();
  h.reply(1, 200, { valid: true, operatingName: 'Next synthetic shop', state: 'reserved' }); await drain();
  h.reply(0, 200, { valid: true, operatingName: 'First synthetic shop', state: 'active' }); await drain();
  assert.equal(h.CD.code, 'CD-NEXT-3333'); assert.equal(h.CD.alreadyOpen, false);
  assert.equal(h.c.state.data.operatingName, 'Next synthetic shop');
});
test('cached IDs reselect their own state; partial IDs never look up and clear the old selection', async () => {
  const h = harness();
  for (const [id, state] of [['CD-FIRS-2222', 'active'], ['CD-NEXT-3333', 'reserved']]) {
    h.CD.checkRef(id, () => {}); h.tick(); h.reply(h.pending.length - 1, 200, { valid: true, operatingName: id, state }); await drain();
  }
  h.CD.checkRef('CD-FIRS-2222', () => {}); assert.equal(h.CD.code, 'CD-FIRS-2222'); assert.equal(h.CD.alreadyOpen, true);
  h.CD.checkRef('CD-NEXT-3333', () => {}); assert.equal(h.CD.alreadyOpen, false);
  h.CD.checkRef('CD-N', () => {}); h.tick(); assert.equal(h.pending.length, 2); assert.equal(h.CD.code, '');
});
test('a malformed success body is a failure rather than permission to advance', async () => {
  const h = harness(); const result = h.CD.h.call('PUT', '/synthetic', {});
  h.pending[0].resolve({ status: 200, json: () => Promise.reject(new SyntaxError('broken JSON')) });
  assert.equal((await result).status, 0);
});
test('a save completing after Back cannot advance another screen', async () => {
  const h = harness(); h.CD.code = 'CD-NEXT-3333'; h.c.state.i = 2; h.c.state.data = { operatingName: 'Synthetic' };
  h.CD.beforeNext(h.c); h.c.state.i = 18; h.reply(0, 200, { ok: true }); await drain();
  assert.equal(h.c.state.i, 18);
});
test('a coins-only count survives, and the selected total mode wins over old denominations', async () => {
  const h = harness(); h.c.state.cntMode = { CAD: 'notes' };
  const data = { currencies: [], count: { CAD: { coins: '12.35', den: {}, done: true } }, float: { CAD: '99.00' } };
  h.CD.save(h.c, 8, data);
  assert.deepEqual(JSON.parse(h.pending[0].args[1].body).answers.count.CAD, { mode: 'notes', notes: {}, coins: '12.35', done: true });
  h.c.state.cntMode.CAD = 'total'; data.count.CAD.den = { '20': '3' }; h.CD.save(h.c, 8, data);
  assert.deepEqual(JSON.parse(h.pending[1].args[1].body).answers.count.CAD, { mode: 'total', total: '99.00', done: true });
});
test('negative amounts and fractional note quantities are refused without silently changing cash', async () => {
  const h = harness(); h.c.state.cntMode = { CAD: 'total' };
  const result = h.CD.save(h.c, 8, { currencies: [], count: {}, float: { CAD: '-12.35' } });
  assert.equal(h.pending.length, 0); const r = await result;
  assert.equal(r.status, 422); assert.equal(h.pending.length, 0);
  h.c.state.cntMode.CAD = 'notes';
  const n = await h.CD.save(h.c, 8, { currencies: [], count: { CAD: { den: { '20': '1.5' } } } });
  assert.equal(n.status, 422); assert.equal(h.pending.length, 0);
});
test('resume preserves one-shop choice, skipped registration and no-email staff mode', () => {
  const h = harness(); const d = h.CD.fromServer({ shops: 'one', shopCount: 8, regSkipped: true, msbNumber: '', countLater: true, team: [{ first: 'Synthetic', last: 'Person', role: 'Cashier', mode: 'noemail' }] });
  assert.equal(d.shopCount, 1); assert.equal(d.regSkipped, true); assert.equal(d.countLater, true); assert.equal(d.team[0].mode, 'noemail');
});

test('the response-body timeout stays armed until JSON finishes', async () => {
  const h = harness(); const result = h.CD.h.call('GET', '/synthetic');
  h.pending[0].resolve({ status: 200, json: () => new Promise((resolve, reject) => h.pending[0].args[1].signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await drain(); h.tick(); assert.equal(h.pending[0].args[1].signal.aborted, true);
  assert.equal((await result).status, 0);
});
test('Back and return to the same screen still invalidates the old save navigation', async () => {
  const h = harness(); h.c.state.i = 2; h.CD.beforeNext(h.c); h.CD.navigation();
  h.reply(0, 200, { ok: true }); await drain(); assert.equal(h.c.state.i, 2);
});
