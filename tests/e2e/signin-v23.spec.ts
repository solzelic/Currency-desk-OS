/* CD-221: use the actual compiled OS and SignIn lifecycle. Only this browser
   response selects the presentation prop; no fixture endpoint/flag ships. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

const marker = '/* ---- os-src/cdos-os.jsx ---- */';
const out = process.env.SIGNIN_CAPTURE_DIR;
async function open(page: Page) {
  const bundle = readFileSync('web/app/os.js', 'utf8');
  expect(bundle.split(marker)).toHaveLength(2);
  await page.route('**/web/app/os.js', route => route.fulfill({
    contentType: 'application/javascript', body: bundle.replace(marker, `
      const ShippedSignIn = window.CDOS.SignIn;
      window.CDOS.SignIn = props => React.createElement(ShippedSignIn, {...props, presentation:'v23'});
      ${marker}`),
  }));
  await page.goto('/login');
  await expect(page.getByLabel('Email or CurrencyDesk ID')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function password(page: Page, id = 'daniel@yorkcurrency.ca') {
  await page.getByLabel('Email or CurrencyDesk ID').fill(id);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible();
}
async function capture(page: Page, state: string, size: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const spec = await page.locator('.si23').evaluate(root => {
    const elements = [...root.querySelectorAll('*')].flatMap(e => {
      const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      if (r.width < 1 || r.height < 1 || c.visibility === 'hidden') return [];
      const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
      if (!own && !/^(BUTTON|INPUT|A)$/.test(e.tagName)) return [];
      return [{ tag: e.tagName.toLowerCase(), text: e instanceof HTMLInputElement ? '[input] ' + (e.type === 'password' && e.value ? '[masked]' : e.value || e.placeholder) : own,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        font: c.fontFamily.split(',')[0].replace(/"/g, '') + ' ' + c.fontWeight + ' ' + c.fontSize + '/' + c.lineHeight + (c.letterSpacing !== 'normal' ? ' ls ' + c.letterSpacing : ''),
        color: c.color, bg: c.backgroundColor, radius: c.borderRadius, border: c.borderTopWidth + ' ' + c.borderTopColor }];
    });
    return { viewport: [innerWidth, innerHeight], horizontalOverflow: root.scrollWidth > root.clientWidth, pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
      scrollers: [root, ...root.querySelectorAll('*')].filter(e => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(e => ({ what: e.className, extra: e.scrollHeight - e.clientHeight })), elements };
  });
  expect(spec.pageScrolls).toBe(false);
  expect(spec.horizontalOverflow).toBe(false);
  // Original first-screen phone sheet may scroll; compare its measurements below.
  if (!['small', 'phone'].includes(size) || state.startsWith('02')) expect(spec.scrollers).toEqual([]);
  if (size !== 'compact') {
    const reference = JSON.parse(readFileSync(`tests/fixtures/signin-v23/${state}.${size}.json`, 'utf8'));
    if (!reference.scrollers.length) expect(spec.scrollers).toEqual([]);
    // Deliberate exceptions are named, not a widened global tolerance:
    // 10px minimum mono; 44px targets; no unverified shop name; phone header
    // no longer overflows by 4px when the hidden progress counter is removed.
    for (const actual of spec.elements) {
      const original = reference.elements.find((e: any) => e.text === actual.text && (e.tag === actual.tag || (e.tag === 'a' && actual.tag === 'button')));
      if (!original || ['OS','Recommended','Show',''].includes(actual.text)) continue;
      if (state === '01-signin-id' && ['Sign in','Open  desk','the'].includes(actual.text)) continue;
      if (state.startsWith('02') && ['phone','small'].includes(size) && actual.text === 'Back') continue;
      for (const key of ['x','y','w','h'] as const) {
        if (key === 'y' && state === '01-signin-id' && size === 'small') continue; // absent 37px unverified shop lede
        if (key === 'w' && state.startsWith('01') && ['phone','small'].includes(size) && actual.tag === 'input') continue;
        expect(Math.abs(actual[key] - original[key]), `${state}.${size} ${actual.text} ${key}`).toBeLessThanOrEqual(1);
      }
      expect(actual.font, `${state}.${size} ${actual.text} font`).toBe(original.font);
      expect(actual.color, `${state}.${size} ${actual.text} color`).toBe(original.color);
      if (original.radius) expect(actual.radius).toBe(original.radius);
      if (original.bg) expect(actual.bg).toBe(original.bg);
    }
  }
  if (out) {
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `${state}.${size}.png`), animations: 'disabled' });
    writeFileSync(path.join(out, `${state}.${size}.json`), JSON.stringify(spec, null, 2));
    if (size !== 'compact') {
      const ref = JSON.parse(readFileSync(`tests/fixtures/signin-v23/${state}.${size}.json`, 'utf8'));
      const differences = spec.elements.flatMap(actual => {
        const original = ref.elements.find((e: any) => e.tag === actual.tag && e.text === actual.text);
        if (!original) return [{ text: actual.text, difference: 'added or changed content' }];
        const delta = Object.fromEntries(['x','y','w','h'].map(k => [k, (actual as any)[k] - original[k]]));
        return Object.values(delta).some(v => Math.abs(v) > 1) || actual.font !== original.font || actual.color !== original.color
          ? [{ text: actual.text, delta, originalFont: original.font, actualFont: actual.font, originalColor: original.color, actualColor: actual.color }] : [];
      });
      writeFileSync(path.join(out, `${state}.${size}.comparison.json`), JSON.stringify(differences, null, 2));
    }
  }
  return spec;
}

test.describe('v2.3 bounded presentation', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-CA' });
  for (const [size, width, height] of [['desktop',1440,860],['laptop',1280,760],['phone',390,844],['small',360,740],['compact',1100,700]] as const) {
    test(`deterministic first and password states at ${size}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.clock.setFixedTime(new Date('2026-11-13T14:00:00-05:00'));
      await open(page);
      await page.addStyleTag({ content: '.si23 *, .si23 *::before, .si23 *::after {animation:none!important;transition:none!important}' });
      await capture(page, '01-signin', size);
      expect((await new AxeBuilder({ page }).include('.si23').analyze()).violations).toEqual([]);
      await expect(page.getByRole('button', { name: /Continue with a passkey/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeDisabled();
      await page.getByLabel('Email or CurrencyDesk ID').fill('cd york 7k42');
      await expect(page.getByLabel('Email or CurrencyDesk ID')).toHaveValue('CD-YORK-7K42');
      // No synthetic shop lookup: the real contract has not returned a name.
      await expect(page.getByText('York Currency Exchange', { exact: true })).toHaveCount(0);
      await capture(page, '01-signin-id', size);
      await page.getByLabel('Email or CurrencyDesk ID').fill('daniel@yorkcurrency.ca');
      await capture(page, '01-signin-email', size);
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
      await capture(page, '02-password', size);
      expect((await new AxeBuilder({ page }).include('.si23').analyze()).violations).toEqual([]);
      await page.route('**/api/auth/login/start', r => r.fulfill({ status: 401, json: { error:'invalid_credentials' } }));
      await page.getByLabel('Password', { exact: true }).fill('wrong1');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert')).toContainText('password');
      await capture(page, '02-password-wrong', size);
      expect((await new AxeBuilder({ page }).include('.si23').analyze()).violations).toEqual([]);
      for (const b of await page.locator('.si23 button:visible').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.getByRole('button', { name: 'Change', exact: true }).click();
      await expect(page.getByLabel('Email or CurrencyDesk ID')).toBeFocused();
    });
  }
  test('keyboard, reduced motion and safe back/recovery', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const id = page.getByLabel('Email or CurrencyDesk ID');
    await id.fill('cd.office@example.test');
    await expect(id).toHaveValue('cd.office@example.test');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeFocused();
    expect(await page.getByRole('button', { name: 'Continue', exact: true }).evaluate(e => getComputedStyle(e).outlineStyle)).toBe('solid');
    expect(await page.locator('.si23-dot').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
    await page.keyboard.press('Enter');
    await page.getByLabel('Password', { exact: true }).fill('disposable-test-only');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await password(page);
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('button', { name: /Send me a code/i })).toBeVisible();
  });
  test('network failure fails closed even on localhost; server lock and 503 stay authoritative', async ({ page }) => {
    await open(page); await password(page, 'm.costa');
    await page.route('**/api/auth/login/start', r => r.abort());
    await page.getByLabel('Password', { exact: true }).fill('disposable-test-only');
    await page.getByRole('button', { name: 'Continue →' }).click();
    await expect(page.getByRole('alert')).toContainText('unavailable');
    await expect(page.getByText('Check your email', { exact: true })).toHaveCount(0);
    await page.unroute('**/api/auth/login/start');
    await page.route('**/api/auth/login/start', r => r.fulfill({ status:503, json:{} }));
    await page.getByRole('button', { name: 'Continue →' }).click();
    await expect(page.getByRole('alert')).toContainText('having trouble');
    await page.unroute('**/api/auth/login/start');
    await page.route('**/api/auth/login/start', r => r.fulfill({ status:429, json:{error:'too_many_attempts',until:'10:42 AM'} }));
    await page.getByRole('button', { name: 'Continue →' }).click();
    await expect(page.getByRole('alert')).toContainText('Try again at 10:42 AM');
    await expect(page.getByRole('button', { name: 'Continue →' })).toBeDisabled();
  });
  test('production URLs cannot activate the capture composition', async ({ page }) => {
    await page.goto('/login?presentation=v23&test-step=who');
    await expect(page.getByPlaceholder('your-staff-id')).toBeVisible();
    await expect(page.locator('.si23')).toHaveCount(0);
  });
  test('email challenge uses the existing code screen and submission latch', async ({ page }) => {
    await open(page); await password(page);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/auth/login/start', async r => {
      calls++; await gate;
      await r.fulfill({ json: { needsCode: true, maskedEmail:'d•••@example.test', user:{id:'daniel@yorkcurrency.ca',role:'teller'} } });
    });
    await page.getByLabel('Password', { exact: true }).fill('disposable-test-only');
    await page.keyboard.press('Enter');
    await expect.poll(() => calls).toBe(1);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
    release();
    await expect(page.getByText('Check your email', { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });
  test('real password-only server session reaches the existing OS', async ({ page }) => {
    await open(page); await password(page, 'm.costa');
    await page.getByLabel('Password', { exact: true }).fill('yorkville');
    const response = page.waitForResponse('**/api/auth/login/start');
    await page.getByRole('button', { name: 'Continue →' }).click();
    expect((await response).status()).toBe(200);
    await expect(page.locator('.si23')).toHaveCount(0);
    const session = await page.request.get('/api/auth/me');
    expect(session.status()).toBe(200);
    expect((await session.json()).user.id).toBe('m.costa');
  });
});
