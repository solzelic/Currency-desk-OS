import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Check the source and the page served at /signup. These are the applicable
// CD-177/178 changes on the existing eight-step application, not a v2 flow.
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
}
