import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Check the source and the page served at /signup. These are the applicable
// CD-177/178/179/180 changes on the existing eight-step application, not a v2 flow.
for (const file of ['design/site/CurrencyDesk Early Access.dc.html', 'web/early-access.html']) {
  const html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  test(`${file}: holds a place without an unsigned data claim`, () => {
    assert.ok(html.includes("We're opening the desk to a first group of shops in Canada. Apply, and we'll hold your place."));
    const legal = html.match(/<p style="([^"]*)">By applying[\s\S]*?<\/p>/)?.[0];
    assert.ok(legal, 'legal line exists');
    assert.match(legal, /font-size: 13px;/);
    assert.match(legal, /color: #6B6459;/);
    assert.match(legal, />Terms<\/a>/);
    assert.match(legal, />Privacy Policy<\/a>/);
    assert.match(legal, /No card required\./);
    assert.doesNotMatch(legal, /never sell your data/i);
  });
  test(`${file}: the animated top bar has only green and amber stops`, () => {
    const bar = html.match(/<div aria-hidden="true" style="[^"]*animation: cdBar 9s linear infinite;[^"]*">/)?.[0];
    assert.ok(bar, 'existing nine-second bar remains');
    assert.match(bar, /linear-gradient\(90deg, #1D6B45, #A9791C, #1D6B45\)/);
  });
  test(`${file}: literal address copy and static navigation markup contract`, () => {
    assert.ok(html.includes("Your shop's address on CurrencyDesk. It's yours the moment you finish."));
    assert.ok(html.includes('Reserve your desk.'));
    assert.match(html, /nextLabel }}<svg/);
    assert.match(html, /width: '44px', height: '44px'/);
    assert.doesNotMatch(html, /Tap anywhere to skip/);
  });
  test(`${file}: volume question explains the estimate and its currency`, () => {
    assert.ok(html.includes('>About how much do you exchange a month?</h2>'));
    assert.ok(html.includes('>A ballpark in Canadian dollars.</p>'));
    assert.ok(!html.includes('How much do you move a month?'));
    assert.ok(!html.includes('Ballpark is perfect. It shapes how we build your desk from day one.'));
  });
  test(`${file}: name and mobile copy is plain without changing call expectations`, () => {
    assert.ok(html.includes('>Your name goes on your Founding Operator card.</p>'));
    assert.ok(html.includes(">What's your mobile number?</h2>"));
    assert.ok(!html.includes('Last thing. Your name goes on your Founding Operator card.'));
    assert.ok(!html.includes('Where do we call you?'));
    assert.ok(html.includes('If we approve you, we call. The call is mostly us listening, and we follow up once the desk is in your hands.'));
    assert.match(html, /case 6: return this\.phoneOk\(s\.phone\) && !!s\.callWindow;/);
    assert.match(html, /case 7: return s\.name\.trim\(\)\.length > 1 && !!s\.role && !!s\.employees;/);
    if (file.startsWith('web/')) assert.match(html, /bestTime: s\.callWindow/);
  });
  test(`${file}: plain compliance labels preserve all saved values and selection`, () => {
    const section = html.match(/    const stacks = [\s\S]*?(?=    const timelineData =)/)?.[0];
    assert.ok(section, 'the actual option-building code exists');
    // Execute only the option builder, with its state and style dependencies.
    // The same values feed runningOn in the generated enquiry payload.
    const optionsFor = new Function('s', section + '\nreturn stackOpts;');
    const values = ['Spreadsheets & manual logs', 'Legacy MSB software', 'A patchwork of apps', 'Outsourced to a firm', 'Nothing formal yet'];
    const labels = ['Spreadsheets & manual logs', 'MSB software we use', 'A mix of apps', 'Outsourced to a firm', 'Nothing formal yet'];
    for (const selected of [null, ...values]) {
      const picked = [];
      const context = {
        pick: (key, value) => () => picked.push([key, value]),
        rowStyle: (active, color) => ({ active, color })
      };
      const options = optionsFor.call(context, { stack: selected });
      assert.deepEqual(options.map(option => option.label), labels);
      options.forEach((option, index) => {
        option.onClick();
        assert.deepEqual(picked[index], ['stack', values[index]]);
        assert.deepEqual(option.style, { active: values[index] === selected, color: '#C2452D' });
        assert.equal(option.tick.opacity, values[index] === selected ? 1 : 0);
      });
    }
    if (file.startsWith('web/')) assert.match(html, /runningOn: s\.stack/);
  });
}

// Exercise the actual certificate callback without a browser or outbound writes.
for (const file of ['design/site/CurrencyDesk Early Access.dc.html', 'web/early-access.html']) {
  const html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const body = html.match(/download = async \(\) => \{([\s\S]*?)\n  \};\n  share =/)?.[1];
  assert.ok(body, 'certificate callback exists');
  const download = new Function('document', 'return async function () {' + body + '\n}');
  async function record(failExport = false) {
    const drawn = [], messages = [], exports = [];
    let clicks = 0;
    const context = new Proxy({}, {
      get: (_, key) => key === 'fillText' ? (...args) => drawn.push(args)
        : key === 'measureText' ? () => ({ width: 20 })
        : key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {},
      set: () => true
    });
    const canvas = { getContext: () => context, toDataURL: type => {
      exports.push(type);
      if (failExport) throw new Error('synthetic export failure');
      return 'data:image/png;base64,synthetic';
    } };
    const anchor = { click: () => { clicks++; } };
    const document = { fonts: { ready: Promise.resolve() }, createElement: tag => {
      assert.ok(['canvas', 'a'].includes(tag));
      return tag === 'canvas' ? canvas : anchor;
    } };
    await download(document).call({ state: { name: ' Example Operator ', memberCount: 42 },
      _workspaceFull: () => 'example.invalid', _joinDate: () => 'Nov 12, 2026',
      _jurName: () => 'Canada', flashToast: message => messages.push(message) });
    return { drawn, messages, exports, clicks, anchor, canvas };
  }
  test(`${file}: certificate omits unsigned clauses and keeps fields and PNG export`, async () => {
    const r = await record();
    assert.doesNotMatch(r.drawn.map(x => x[0]).join('\n'), /certifies that|first one hundred|to run their counter|O F\s+1 0 0|held for life/i);
    for (const text of ['Example Operator', 'Nº 0042', 'example.invalid', 'Nov 12, 2026', 'Canada', 'P L A C E   I N   L I N E']) {
      assert.ok(r.drawn.some(x => x[0] === text), text);
    }
    assert.deepEqual(r.drawn.find(x => x[0] === 'Example Operator'), ['Example Operator', 620, 580]);
    assert.deepEqual(r.drawn.find(x => x[0] === 'Nº 0042'), ['Nº 0042', 620, 912]);
    assert.equal(r.canvas.width, 1240); assert.equal(r.canvas.height, 1754);
    assert.deepEqual(r.exports, ['image/png']); assert.equal(r.clicks, 1);
    assert.equal(r.anchor.download, 'CurrencyDesk-Founding-Operator-0042.png');
    assert.equal(r.anchor.href, 'data:image/png;base64,synthetic');
    assert.deepEqual(r.messages, ['Certificate Nº 0042 downloaded.']);
  });
  test(`${file}: certificate export failure never reports success or clicks download`, async () => {
    const r = await record(true);
    assert.equal(r.clicks, 0);
    assert.deepEqual(r.messages, ['Could not build the certificate. Try again.']);
  });
}
