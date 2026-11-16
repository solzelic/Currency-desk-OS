/* Sign-up v2.1, "How will you sign in?": which ways in are offered, and how
   Google/Microsoft come back (popup, BroadcastChannel, phone return), driven
   through the real bridge in a VM with the server answers held by the test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const drain = () => new Promise(r => setImmediate(r));
const ORIGIN = 'https://signup.example.test';

function harness({ search = '', stored = {} } = {}) {
  const pending = [], listeners = {}, channels = [], cleaned = [], intervals = new Map(); let timerId = 0;
  class FakeChannel {
    constructor(name) { this.name = name; this.sent = []; channels.push(this); }
    postMessage(m) { this.sent.push(m); }
    close() {}
  }
  const store = { ...stored };
  const context = {
    window: { addEventListener(type, fn) { listeners[type] = fn; }, innerWidth: 1280 },
    location: { origin: ORIGIN, search, hash: '' },
    history: { replaceState: (_a, _b, url) => cleaned.push(url) },
    sessionStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {},
    document: { hasFocus: () => true },
    fetch: (...args) => new Promise(resolve => pending.push({ args, resolve })),
    setTimeout: () => 0, clearTimeout() {}, setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id),
    AbortController, URLSearchParams, URL, Promise, atob, btoa, Uint8Array, BroadcastChannel: FakeChannel, console,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../design/onboarding/signup-v2.1-bridge.js', import.meta.url), 'utf8'), context);
  const CD = context.window.__cdOnb;
  const c = { state: { i: 5, data: {} }, set(k, v) { this.state.data[k] = v; }, setState(v, cb) { Object.assign(this.state, typeof v === 'function' ? v(this.state) : v); cb?.(); }, forceUpdate() {}, next() { this.state.i++; }, deviceInfo: () => ({ device: 'Mac' }) };
  const reply = (n, status, body) => pending[n].resolve({ status, json: () => Promise.resolve(body) });
  const urls = () => pending.map(p => p.args[0]);
  return { CD, c, pending, reply, urls, listeners, channels, cleaned, store, context, intervals };
}

test('only the ways in this server can finish from this page are offered; all of them until it answers', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.pkAvailable = true;
  for (const id of ['passkey', 'google', 'microsoft', 'password']) assert.equal(h.CD.offers(id), true, id);
  assert.deepEqual(h.urls(), ['/api/onboarding/methods']);
  h.CD.offers('google'); assert.equal(h.pending.length, 1, 'asked once');
  h.reply(0, 200, { password: true, passkey: true, passkeyOrigins: [ORIGIN], google: true, microsoft: false, ssoOrigin: ORIGIN }); await drain();
  assert.deepEqual(['passkey', 'google', 'microsoft', 'password'].map(id => h.CD.offers(id)), [true, true, false, true]);
  h.CD.methods = { password: true, passkey: true, passkeyOrigins: ['https://other.example.test'], google: true, microsoft: true, ssoOrigin: 'https://other.example.test' };
  assert.deepEqual(['passkey', 'google', 'microsoft', 'password'].map(id => h.CD.offers(id)), [false, false, false, true]);
  h.CD.methods = { password: true, passkey: true, passkeyOrigins: [ORIGIN], google: true, microsoft: true, ssoOrigin: ORIGIN };
  h.CD.pkAvailable = false;
  assert.equal(h.CD.offers('passkey'), false, 'a browser that cannot make one is not offered one');
});

test('a phone back from the provider with an error lands on the sign-in screen with one red line, and sends nothing', async () => {
  const h = harness({ search: '?sso=1&error=access_denied&state=S-phone', stored: { cdSignupId: 'CD-TEST-2222', cdSsoReturn: JSON.stringify({ id: 'CD-TEST-2222', provider: 'google' }) } });
  h.CD.mount(h.c);
  assert.deepEqual(h.cleaned, ['/onboarding'], 'the address bar is tidied before anything answers');
  h.reply(0, 200, { valid: true, state: 'reserved', operatingName: 'Synthetic' }); await drain();
  assert.equal(h.c.state.i, 5);
  assert.equal(h.c.state.lockErr, 'The Google sign-in was cancelled. Nothing was linked. Try again, or choose another way.');
  assert.ok(!h.urls().some(u => u.includes('/sso/callback')));
});

test('a phone back with a code finishes it once, for the ID it started from', async () => {
  const h = harness({ search: '?sso=1&code=C-1&state=S-1', stored: { cdSignupId: 'CD-TEST-2222', cdSsoReturn: JSON.stringify({ id: 'CD-TEST-2222', provider: 'microsoft' }) } });
  h.CD.mount(h.c);
  h.reply(0, 200, { valid: true, state: 'reserved', operatingName: 'Synthetic' }); await drain();
  assert.equal(h.urls()[1], '/api/onboarding/CD-TEST-2222/sso/callback');
  assert.deepEqual(JSON.parse(h.pending[1].args[1].body), { provider: 'microsoft', code: 'C-1', state: 'S-1' });
  assert.equal(h.store.cdSsoReturn, undefined);
});

test('the popup is heard only for the round trip this tab started, by message or by channel, and only once', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  const popup = { closed: false, close() { this.closed = true; } };
  h.context.window.open = () => popup;
  h.CD.sso(h.c, 'google');
  h.reply(0, 200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=S-mine&nonce=n' }); await drain();
  assert.equal(popup.location, 'https://accounts.google.com/o/oauth2/v2/auth?state=S-mine&nonce=n');
  h.listeners.message({ origin: ORIGIN, data: { type: 'cd-sso', code: 'C-x', state: 'S-other', error: '' } });
  h.listeners.message({ origin: 'https://evil.example.test', data: { type: 'cd-sso', code: 'C-x', state: 'S-mine', error: '' } });
  assert.equal(h.pending.length, 1, 'another round trip or another origin is ignored');
  const channel = h.channels.find(ch => ch.name === 'cd-sso');
  channel.onmessage({ data: { type: 'cd-sso', code: 'C-1', state: 'S-mine', error: '' } });
  assert.equal(JSON.stringify(channel.sent), JSON.stringify([{ type: 'cd-sso-ack', state: 'S-mine' }]));
  h.listeners.message({ origin: ORIGIN, data: { type: 'cd-sso', code: 'C-1', state: 'S-mine', error: '' } });
  assert.equal(h.pending.length, 2, 'taken once');
  assert.deepEqual(JSON.parse(h.pending[1].args[1].body), { provider: 'google', code: 'C-1', state: 'S-mine' });
});

test('a provider error in the popup is a red line, never a callback', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  h.context.window.open = () => ({ closed: false, close() {} });
  h.CD.sso(h.c, 'microsoft');
  h.reply(0, 200, { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=S-m' }); await drain();
  h.listeners.message({ origin: ORIGIN, data: { type: 'cd-sso', code: '', state: 'S-m', error: 'server_error' } });
  assert.equal(h.pending.length, 1);
  assert.equal(h.c.state.ssoPhase, 'idle');
  assert.equal(h.c.state.lockErr, 'That Microsoft sign-in didn’t finish. Nothing was saved. Try again, or choose another way.');
});


test('a failed methods lookup cannot create a render-driven retry loop', async () => {
  const h = harness(); h.CD.comp = h.c;
  h.c.forceUpdate = () => { h.CD.offers('google'); };
  h.CD.offers('google');
  h.reply(0, 503, { error: 'unavailable' }); await drain();
  assert.equal(h.pending.length, 1, 'failure renders without another automatic request');
  assert.equal(h.CD.offers('password'), true);
});

test('Back abandons a pending provider start before it navigates the popup', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  const popup = { closed: false, close() { this.closed = true; } };
  h.context.window.open = () => popup;
  h.CD.sso(h.c, 'google'); h.CD.navigation(); h.c.state.i = 20;
  h.reply(0, 200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=old' }); await drain();
  assert.equal(popup.location, undefined);
  assert.equal(popup.closed, true);
  assert.equal(h.intervals.size, 0);
});

test('Back and re-entering the same credential screen ignores a late provider success', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  h.context.window.open = () => ({ closed: false, close() {} });
  h.CD.sso(h.c, 'google');
  h.reply(0, 200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=old' }); await drain();
  h.listeners.message({ origin: ORIGIN, data: { type: 'cd-sso', code: 'synthetic', state: 'old' } });
  h.CD.navigation(); h.c.state.i = 5; h.c.state.data.lockMode = 'password';
  h.reply(1, 200, { ok: true, codeSent: true }); await drain();
  assert.equal(h.c.state.data.lockMode, 'password');
  assert.equal(h.c.state.data.ssoDone, undefined);
  assert.equal(h.store.cdSignupInbox, undefined);
});

test('after abandoning the popup, its late channel message cannot submit a credential', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  h.context.window.open = () => ({ closed: false, close() {} });
  h.CD.sso(h.c, 'google');
  h.reply(0, 200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=old' }); await drain();
  h.CD.navigation();
  h.channels[0].onmessage({ data: { type: 'cd-sso', code: 'synthetic', state: 'old' } });
  assert.equal(h.pending.length, 1);
  assert.equal(h.intervals.size, 0);
});


test('a passkey options response after Back cannot open the device prompt', async () => {
  const h = harness(); h.CD.comp = h.c; h.CD.code = 'CD-TEST-2222';
  let prompts = 0;
  h.context.navigator.credentials = { create() { prompts++; return new Promise(() => {}); } };
  h.CD.passkey(h.c); h.CD.navigation(); h.c.state.i = 20;
  h.reply(0, 200, { options: { challenge: 'eA', user: { id: 'eA' }, rp: {}, pubKeyCredParams: [] } }); await drain();
  assert.equal(prompts, 0);
  assert.equal(h.c.state.pkPhase, 'idle');
});
