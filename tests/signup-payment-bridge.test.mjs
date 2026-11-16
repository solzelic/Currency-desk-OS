import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../design/onboarding/signup-v2.1-open.js', import.meta.url), 'utf8');
const drain = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests = [], pending = [], confirms = [], events = {};
  const frame = { contentWindow: {} };
  const stripe = { elements: () => ({ create: () => ({ on() {}, destroy() {}, mount() {} }) }), confirmSetup: args => { confirms.push(args); return Promise.resolve({ error: { message: 'Synthetic failure' } }); } };
  const CD = { h: { api: (method, path, body) => { requests.push({ method, path, body }); return new Promise(resolve => pending.push(resolve)); }, why: (r, fallback) => r.body.detail || fallback, NET: 'Offline' } };
  const context = { window: { addEventListener: (k, fn) => { events[k] = fn; }, __cdOnb: CD, Stripe: () => stripe, __cdAgreementHash: 'pinned-version' }, document: { querySelector: s => s === "iframe[data-real-home]" ? frame : null }, location: { origin: 'https://example.test' }, setTimeout, clearTimeout, console, Promise };
  vm.runInNewContext(source, context);
  const c = { state: { termsRead: true, data: { plan: 'full', term: 'monthly', addons: {}, cardName: 'Synthetic Owner' } }, forceUpdate() {}, locCount: () => 1 };
  const reply = (id = 'seti_first') => ({ status: 200, body: { clientSecret: `${id}_secret`, setupIntentId: id, termsSourceHash: 'pinned-version', publishableKey: 'pk_synthetic' } });
  return { CD, c, requests, pending, confirms, reply, events, frame };
}
test('opening Payment prepares a card without recording assent', async () => {
  const h = harness(); h.CD.card(h.c);
  assert.equal(h.requests[0].path, '/payment');
  assert.equal('agreed' in h.requests[0].body, false);
});
test('a late preparation response cannot replace a newer choice', async () => {
  const h = harness(); h.CD.card(h.c);
  h.c.state.data.term = 'annual'; h.CD.card(h.c);
  h.pending[1](h.reply('seti_new')); await drain();
  h.pending[0](h.reply('seti_old')); await drain();
  assert.equal(h.CD._secret, 'seti_new_secret');
});
test('Open binds actual assent before confirming Stripe; a refusal never confirms the card', async () => {
  const h = harness(); h.CD.card(h.c); h.pending[0](h.reply()); await drain();
  h.CD.pay(h.c); await drain();
  assert.equal(h.requests[1].path, '/agreement');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1].body)), { setupIntentId: 'seti_first', termsSourceHash: 'pinned-version', agreed: true });
  assert.equal(h.confirms.length, 0);
  h.pending[1]({ status: 409, body: { detail: 'Review the changed desk' } }); await drain();
  assert.equal(h.confirms.length, 0); assert.equal(h.CD._paying, false);
});
test('changing the plan after card entry cannot confirm the old card session', async () => {
  const h = harness(); h.CD.card(h.c); h.pending[0](h.reply()); await drain();
  h.c.state.data.term = 'annual'; h.CD.pay(h.c); await drain();
  assert.equal(h.confirms.length, 0);
  assert.equal(h.requests.some(r => r.path === '/agreement'), false);
});

test('Home readiness requires this frame, same origin and this activated tenant', () => {
  const h = harness(); h.CD.tenantId = 'own';
  const message = { origin: 'https://example.test', source: h.frame.contentWindow, data: { type: 'cd-signup-home-ready', tenantId: 'own' } };
  for (const bad of [{ origin: 'https://other.test' }, { source: {} }, { data: { ...message.data, tenantId: 'other' } }]) { h.events.message({ ...message, ...bad }); assert.notEqual(h.CD.homeReady, true); }
  h.events.message(message); assert.equal(h.CD.homeReady, true);
});
