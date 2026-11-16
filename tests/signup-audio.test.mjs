import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function setup(state = 'running', pending = false) {
  let time = 1000, resolve;
  const frames = [], tasks = [], sounds = [], stats = { resume: 0, unlock: 0, bus: 0 };
  const ac = { state, resume() { stats.resume++; return pending ? new Promise(r => { resolve = () => { ac.state = 'running'; r(); }; }) : Promise.resolve().then(() => { ac.state = 'running'; }); }, createBuffer: () => ({}), createBufferSource: () => ({ connect() {}, start() { stats.unlock++; } }) };
  const CD = { muted: false, mount() {}, priced: (c, r) => r, toggleSound() { this.muted = !this.muted; } };
  const c = { _bus() { stats.bus++; this._ac = ac; return ac; }, _toneNow(k) { sounds.push(k); }, forceUpdate() {} };
  vm.runInNewContext(fs.readFileSync(new URL('../design/onboarding/signup-v2.1-audio.js', import.meta.url), 'utf8'), { window: { __cdOnb: CD }, performance: { now: () => time }, requestAnimationFrame: f => frames.push(f), setTimeout: f => tasks.push(f) });
  CD.mount(c);
  return { CD, c, stats, sounds, ac, time(v) { time = v; }, resolve() { resolve(); }, frame() { frames.splice(0).forEach(f => f()); }, task() { tasks.splice(0).forEach(f => f()); }, tap() { c._tapSnd({ target: { closest: () => ({ disabled: false, closest: () => null }) } }); } };
}
const drain = () => new Promise(r => setImmediate(r));
test('no load sound; wake only unlocks; action and fallback yield one sound on next frame', () => {
  const x = setup(); x.c._tone('open'); assert.equal(x.stats.bus, 0); x.frame(); assert.deepEqual(x.sounds, []);
  x.c._warm(); assert.equal(x.stats.unlock, 1); assert.deepEqual(x.sounds, []);
  x.c._clickMark(); x.c._tone('next'); x.tap(); assert.deepEqual(x.sounds, []); x.frame(); assert.deepEqual(x.sounds, ['next']);
  x.task(); x.c._tone('done'); x.frame(); assert.deepEqual(x.sounds, ['next']);
});
test('generic taps suppress within 80ms, then work; slow frames beyond 180ms drop', () => {
  const x = setup(); x.c._warm(); x.c._clickMark(); x.c._tone('next'); x.frame(); x.task();
  x.time(1079); x.c._clickMark(); x.tap(); x.frame(); x.task(); assert.deepEqual(x.sounds, ['next']);
  x.time(1080); x.c._clickMark(); x.tap(); x.frame(); x.task(); assert.deepEqual(x.sounds, ['next', 'tap']);
  x.time(1200); x.c._clickMark(); x.c._tone('next'); x.time(1381); x.frame(); assert.equal(x.sounds.length, 2);
});
for (const state of ['suspended', 'interrupted']) test(`${state} resumes only on wake, and late resume drops`, async () => {
  const x = setup(state, true); x.c._warm(); x.c._warm(); assert.equal(x.stats.resume, 1);
  x.c._clickMark(); x.c._tone('next'); x.time(1181); x.resolve(); await drain(); x.frame(); assert.deepEqual(x.sounds, []);
  assert.equal(x.stats.resume, 1); x.ac.state = 'running'; x.task(); x.time(1300); x.c._clickMark(); x.tap(); x.frame(); assert.deepEqual(x.sounds, ['tap']);
});
test('muting cancels queued sound and persists through the existing preference; unmute does not autoplay', () => {
  const x = setup(); x.c._warm(); x.c._clickMark(); x.c._tone('next'); x.CD.priced(x.c, {}).onSound(); x.frame(); assert.deepEqual(x.sounds, []);
  assert.equal(x.CD.priced(x.c, {}).soundLabel, 'Sound off'); x.CD.priced(x.c, {}).onSound(); x.frame(); assert.deepEqual(x.sounds, []);
});
