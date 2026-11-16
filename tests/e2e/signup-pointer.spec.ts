import { test, expect } from '@playwright/test';
import { SIGNUP_STATES, actions } from './signup-capture-states';
import measureSignup from '../../scripts/signup-capture-measure.cjs';

for (const width of [1280, 390, 360]) test(`all signup states keep controls pointer-reachable at ${width}`, async ({ page }, info) => {
  test.setTimeout(360_000);
  await page.setViewportSize({ width, height: width === 1280 ? 760 : width === 360 ? 740 : 844 });
  const evidence: { state: string; targets: number }[] = [];
  for (const [state, , step, act] of SIGNUP_STATES) {
    await page.goto('/onboarding?step=' + step);
    await page.waitForTimeout(2500);
    if (act) await act(actions(page));
    if (step === 'signin-google') await expect(page.locator('[data-logo="microsoft"]')).toBeDisabled();
    const controls = page.locator('[data-product] button,[data-product] a[href],[data-product] input,[data-product] summary');
    let targets = 0;
    for (const control of await controls.all()) {
      const usable = await control.evaluate(e => !e.matches(':disabled') && !e.closest('[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      if (!usable) continue;
      await control.scrollIntoViewIfNeeded();
      const hit = await control.evaluate(e => {
        const r = e.getBoundingClientRect();
        const points = [[.5, .5], [.2, .5], [.8, .5], [.5, .2], [.5, .8]].map(([x, y]) => document.elementFromPoint(r.x + r.width * x, r.y + r.height * y));
        return { label: e.getAttribute('aria-label') || e.textContent?.trim(), reachable: points.every(top => !!top && (top === e || e.contains(top))), blocking: points.filter(top => !top || !e.contains(top)).map(top => top?.closest('summary,button')?.textContent?.trim()) };
      });
      expect(hit.reachable, JSON.stringify({ state, ...hit })).toBe(true);
      targets++;
    }
    evidence.push({ state, targets });
  }
  await info.attach('pointer-evidence', { body: JSON.stringify({ width, evidence }), contentType: 'application/json' });
});

for (const [width, height] of [[1280, 760], [1440, 860], [1440, 900]]) test(`all signup states fit the product viewport at ${width}x${height}`, async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width, height });
  const evidence = [];
  for (const [state, , step, act] of SIGNUP_STATES) {
    await page.goto('/onboarding?step=' + step);
    await page.waitForTimeout(2500);
    if (act) await act(actions(page));
    const measured = await page.evaluate(measureSignup);
    const cardScrolls = await page.locator('[data-stage]').evaluateAll(es => es.some(e => e.scrollHeight > e.clientHeight + 1));
    evidence.push({ state, documentScrolls: measured.documentScrolls, productScrolls: measured.productScrolls, cardScrolls, scrollers: measured.scrollers });
  }
  await info.attach('scroll-evidence', { body: JSON.stringify({ width, height, evidence }), contentType: 'application/json' });
  expect(evidence.filter(e => e.documentScrolls || e.productScrolls || e.cardScrolls), 'No state scrolls the document, product viewport or card body').toEqual([]);
});

/* Linux CI draws this text about 0.3px per glyph wider than macOS, which once
   wrapped the ID hint and overflowed fitted cards there only. Reproduce that
   metric on any machine so a zero-slack card fails locally, not just in CI. */
for (const [width, height] of [[1280, 760], [1440, 860]]) test(`all signup states fit with wider renderer text at ${width}x${height}`, async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width, height });
  const evidence = [];
  for (const [state, , step, act] of SIGNUP_STATES) {
    await page.goto('/onboarding?step=' + step);
    await page.waitForTimeout(2500);
    if (act) await act(actions(page));
    await page.evaluate(() => new Promise(done => {
      document.querySelectorAll('[data-product] *').forEach(e => { if (getComputedStyle(e).letterSpacing === 'normal') (e as HTMLElement).style.letterSpacing = '0.3px'; });
      requestAnimationFrame(() => requestAnimationFrame(done));
    }));
    const measured = await page.evaluate(measureSignup);
    const cardScrolls = await page.locator('[data-stage]').evaluateAll(es => es.some(e => e.scrollHeight > e.clientHeight + 1));
    evidence.push({ state, documentScrolls: measured.documentScrolls, productScrolls: measured.productScrolls, cardScrolls, scrollers: measured.scrollers });
  }
  await info.attach('wide-text-scroll-evidence', { body: JSON.stringify({ width, height, evidence }), contentType: 'application/json' });
  expect(evidence.filter(e => e.documentScrolls || e.productScrolls || e.cardScrolls), 'No state scrolls the document, product viewport or card body with wider text').toEqual([]);
});
