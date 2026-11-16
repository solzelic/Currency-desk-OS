import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function setup(call = false) {
  const requests = [];
  const CD = { code: 'synthetic', callPreference: { call, canCall: true, phone: '••• 0123', text: 'Exact consent.', version: 'version', target: 'target' }, priced: (c, r) => r, h: { api: (...args) => new Promise(resolve => requests.push({ args, resolve })), why: r => r.body.detail || 'Not saved' } };
  vm.runInNewContext(fs.readFileSync(new URL('../design/onboarding/signup-v2.1-consent.js', import.meta.url), 'utf8'), { window: { __cdOnb: CD } });
  const c = { data: { call }, forceUpdate() {}, set(k, v) { this.data[k] = v; } };
  return { CD, c, requests };
}
const drain = () => new Promise(r => setImmediate(r));
test('consent is not optimistic and failed requests retain the saved value', async () => {
  const { CD, c, requests } = setup(); CD.toggleCall(c); CD.toggleCall(c);
  assert.equal(requests.length, 1); assert.equal(c.data.call, false);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].args)), ['POST', '/preferences', { call: true, version: 'version', target: 'target' }]);
  requests[0].resolve({ status: 502, body: {} }); await drain();
  assert.equal(c.data.call, false); assert.equal(CD.priced(c, {}).samStatus, 'Not saved');
  CD.toggleCall(c); requests[1].resolve({ status: 200, body: { preference: { ...CD.callPreference, call: true } } }); await drain();
  assert.equal(c.data.call, true); assert.equal(CD.callPreference.call, true);
});
test('opt-out saves immediately without starting a payment request', async () => {
  const { CD, c, requests } = setup(true); CD.toggleCall(c);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].args)), ['POST', '/preferences', { call: false }]);
  requests[0].resolve({ status: 200, body: { preference: { ...CD.callPreference, call: false } } }); await drain();
  assert.equal(c.data.call, false); assert.match(CD.priced(c, {}).samText, /Exact consent/);
});
test('a previous reservation cannot change the new reservation preference', async () => {
  const { CD, c, requests } = setup(); CD.toggleCall(c); CD.code = 'next';
  requests[0].resolve({ status: 200, body: { preference: { call: true } } }); await drain();
  assert.equal(c.data.call, false); assert.equal(CD.callPreference.call, false);
});
