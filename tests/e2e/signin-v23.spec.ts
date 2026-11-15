/* CD-221: use the actual compiled OS and SignIn lifecycle. Only this browser
   response selects the presentation prop; no fixture endpoint/flag ships. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, signInAsOperator } from './fixtures';

const marker = '/* ---- os-src/cdos-os.jsx ---- */';
const out = process.env.SIGNIN_CAPTURE_DIR;
type ElementMeasure = { tag: string; text: string; x: number; y: number; w: number; h: number; font: string; color: string; bg?: string; radius?: string };
// One semantic match rule for assertions AND reports. Native buttons replace
// prototype anchors which acted as buttons without a destination.
const sameElement = (original: ElementMeasure, actual: ElementMeasure) =>
  original.text === actual.text && (original.tag === actual.tag || (original.tag === 'a' && actual.tag === 'button'));

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
async function tapTargets(page: Page) {
  for (const b of await page.locator('.si23 button:visible').all()) {
    const box = await b.boundingBox();
    expect(box?.height ?? 0, await b.innerText()).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, await b.innerText()).toBeGreaterThanOrEqual(44);
  }
}
async function measure(page: Page, selector: string) {
  return page.locator(selector).evaluate(root => {
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
}

// Keep the supplied measurements immutable for
// copy/style checks; render the SHA-locked original in this browser for geometry.
// This fixture is intercepted only here, never served by the application.
async function referenceInBrowser(page: Page, state: string, size: string) {
  const hashes: Record<string, string> = JSON.parse(readFileSync('tests/fixtures/signin-v23/font-sha256.json', 'utf8'));
  for (const [name, hash] of Object.entries(hashes)) {
    expect(createHash('sha256').update(readFileSync(path.join('web/fonts', name))).digest('hex'), name).toBe(hash);
  }
  const html = readFileSync('tests/fixtures/signin-v23/prototype.html');
  expect(createHash('sha256').update(html).digest('hex')).toBe('9f59182e10a6e817d39314714921b05e15a08acb9349937a6c995929632164cf');
  const reference = await page.context().newPage();
  try {
    await reference.setViewportSize(page.viewportSize()!); // all callers set an explicit viewport
    await reference.clock.setFixedTime(new Date('2026-11-13T14:00:00-05:00'));
    await reference.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://signin-reference.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:html });
      const name = url.pathname.split('/').pop() || '';
      if (/^(fonts\.css|[a-z0-9-]+\.woff2)$/.test(name)) {
        return route.fulfill({ path:path.join('web/fonts', name) });
      }
      return route.abort();
    });
    await reference.goto('http://signin-reference.test/?bare=1&s=' + (state.startsWith('01') ? 'who' : 'pw'));
    await reference.addStyleTag({ content:'*, *::before, *::after {animation:none!important;transition:none!important}' });
    if (state === '01-signin-id') await reference.locator('#idf').fill('cd york 7k42');
    if (state === '01-signin-email') await reference.locator('#idf').fill('daniel@yorkcurrency.ca');
    if (state === '02-password-wrong') {
      await reference.locator('#pwf').fill('wrong1');
      await reference.locator('#pwf').press('Enter');
      await expect(reference.locator('.hint.err')).toBeVisible();
    }
    await reference.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const result = await measure(reference, '#screen');
    await test.info().attach(`${state}.${size}.reference.png`, { body:await reference.screenshot(), contentType:'image/png' });
    if (out) {
      mkdirSync(out, { recursive:true });
      writeFileSync(path.join(out, `${state}.${size}.reference.json`), JSON.stringify(result, null, 2));
    }
    // Always retain the same-platform oracle, even when a comparison fails.
    await test.info().attach(`${state}.${size}.reference.json`, { body:JSON.stringify(result), contentType:'application/json' });
    return result;
  } finally { await reference.close(); }
}

async function capture(page: Page, state: string, size: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const spec = await measure(page, '.si23');
  expect(spec.pageScrolls).toBe(false);
  expect(spec.horizontalOverflow).toBe(false);
  // Original first-screen phone sheet may scroll; compare its measurements below.
  if (!['small', 'phone'].includes(size) || state.startsWith('02')) expect(spec.scrollers).toEqual([]);
  if (size !== 'compact') {
    const reference: { elements: ElementMeasure[]; scrollers: unknown[] } = JSON.parse(readFileSync(`tests/fixtures/signin-v23/${state}.${size}.json`, 'utf8'));
    const renderedReference = await referenceInBrowser(page, state, size);
    await test.info().attach(`${state}.${size}.candidate.png`, { body:await page.screenshot(), contentType:'image/png' });
    await test.info().attach(`${state}.${size}.candidate.json`, { body:JSON.stringify(spec), contentType:'application/json' });
    const missing = reference.elements.filter(original => !spec.elements.some(actual => sameElement(original, actual)));
    expect(missing.map(e => e.text).sort()).toEqual((state.startsWith('01') ? ['G', ...(state === '01-signin-id' ? ['Signing in to', 'York Currency Exchange'] : [])] : []).sort());
    if (!reference.scrollers.length) expect(spec.scrollers).toEqual([]);
    // Deliberate exceptions are named, not a widened global tolerance:
    // 10px minimum mono; 44px targets; no unverified shop name; phone header
    // no longer overflows by 4px when the hidden progress counter is removed.
    for (const actual of spec.elements) {
      const original = reference.elements.find(e => sameElement(e, actual));
      expect(original, `${state}.${size} unexpected content: ${actual.text}`).toBeTruthy();
      if (!original) continue; // assertion above gives the missing element
      const geometry = renderedReference.elements.find(e => sameElement(original, e));
      expect(geometry, `${state}.${size} original replay missing: ${actual.text}`).toBeTruthy();
      if (!geometry) continue;
      const phone = ['phone','small'].includes(size);
      const adjustedBox = ['OS','Recommended','Show',''].includes(actual.text)
        || (state === '01-signin-id' && ['Sign in','Open  desk','the'].includes(actual.text))
        || (state.startsWith('02') && phone && actual.text === 'Back');
      if (!adjustedBox) for (const key of ['x','y','w','h'] as const) {
        if (key === 'y' && state === '01-signin-id' && size === 'small') continue; // absent 37px unverified shop lede
        if (key === 'w' && state.startsWith('01') && phone && actual.tag === 'input') continue;
        expect(Math.abs(actual[key] - geometry[key]), `${state}.${size} ${actual.text} ${key}`).toBeLessThanOrEqual(1);
      }
      const font = actual.text === 'OS' ? 'IBM Plex Mono 800 10px/normal ls 1px'
        : actual.text === 'Recommended' ? 'IBM Plex Mono 700 10px/normal ls 1.4px' : original.font;
      const color = actual.text === 'OS' && phone ? 'rgb(123, 224, 168)' : original.color;
      expect(actual.font, `${state}.${size} ${actual.text} font`).toBe(font);
      expect(actual.color, `${state}.${size} ${actual.text} color`).toBe(color);
      if (original.radius) expect(actual.radius).toBe(original.radius);
      if (original.bg) expect(actual.bg).toBe(original.bg);
    }
  }
  if (out) {
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `${state}.${size}.png`), animations: 'disabled' });
    writeFileSync(path.join(out, `${state}.${size}.json`), JSON.stringify(spec, null, 2));
    if (size !== 'compact') {
      const ref: { elements: ElementMeasure[] } = JSON.parse(readFileSync(`tests/fixtures/signin-v23/${state}.${size}.json`, 'utf8'));
      const differences = spec.elements.flatMap(actual => {
        const original = ref.elements.find(e => sameElement(e, actual));
        if (!original) return [{ text: actual.text, difference: 'added or changed content' }];
        const delta = Object.fromEntries((['x','y','w','h'] as const).map(k => [k, actual[k] - original[k]]));
        return Object.values(delta).some(v => Math.abs(v) > 1) || actual.font !== original.font || actual.color !== original.color
          ? [{ text: actual.text, delta, originalFont: original.font, actualFont: actual.font, originalColor: original.color, actualColor: actual.color }] : [];
      });
      const missing = ref.elements.filter(original => !spec.elements.some(actual => sameElement(original, actual))).map(e => ({ text: e.text, difference: 'missing reference content (documented exception)' }));
      writeFileSync(path.join(out, `${state}.${size}.comparison.json`), JSON.stringify([...differences, ...missing], null, 2));
    }
  }
  return spec;
}

test.describe('v2.3 bounded presentation', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-CA' });
  for (const typed of ['CD-YORK-0042', 'cd-york-0042', 'cdbeckham7@x.io', 'cd-jones@shop.com']) {
    test(`keystrokes preserve identity ${typed}`, async ({ page }) => {
      await open(page);
      const field = page.getByLabel('Email or CurrencyDesk ID');
      await field.pressSequentially(typed);
      await expect(field).toHaveValue(typed);
      await page.keyboard.press('Enter');
      await expect(page.locator('.si23-who-id b')).toHaveText(typed);
    });
  }
  test('recovery clears the previous password and visibility before another identity', async ({ page }) => {
    await open(page); await password(page);
    await page.getByLabel('Password', { exact: true }).fill('disposable-test-only');
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.getByRole('button', { name: '← Back to sign in' }).click();
    await password(page, 'next@example.test');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  });
  test('complete IDs format on blur while later email edits retain the raw local part', async ({ page }) => {
    await open(page);
    const field = page.getByLabel('Email or CurrencyDesk ID');
    await field.pressSequentially('cdbeckham7');
    await page.keyboard.press('Tab');
    // This is only a visual spelling. The real-account regressions below
    // assert that Continue and the request preserve cdbeckham7 verbatim.
    await expect(field).toHaveValue('CD-BECK-HAM7');
    await page.keyboard.press('Shift+Tab');
    await expect(field).toHaveValue('cdbeckham7');
    await page.keyboard.press('End');
    await field.pressSequentially('@x.io');
    await page.keyboard.press('Tab');
    await expect(field).toHaveValue('cdbeckham7@x.io');
    for (const spelling of ['york7k42', 'cdyork7k42', 'cd york 7k42']) {
      await field.fill(spelling);
      await page.keyboard.press('Tab');
      await expect(field).toHaveValue('CD-YORK-7K42');
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('.si23-who-id b')).toHaveText('cd york 7k42');
  });
  test('password reset preserves its confirmation and cooldown with a masked empty field', async ({ page }) => {
    await open(page); await password(page);
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    await page.route('**/api/auth/forgot', r => r.fulfill({ json: { ok: true } }));
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByPlaceholder('000000').fill('123456');
    await page.getByPlaceholder('At least 8 characters').fill('disposable-reset-only');
    await page.getByRole('button', { name: 'SHOW', exact: true }).click();
    await page.route('**/api/auth/reset', r => r.fulfill({ json: { ok: true } }));
    await page.getByRole('button', { name: 'Set my new password' }).click();
    await expect(page.getByRole('status')).toContainText('Password changed. Sign in with the new one.');
    await expect(page.getByText(/Another code in \d+s/)).toHaveAttribute('aria-live', 'off');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  });
  for (const [size, width, height] of [['desktop',1440,860],['laptop',1280,760],['phone',390,844],['small',360,740],['compact',1100,700]] as const) {
    test(`deterministic first and password states at ${size}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.clock.setFixedTime(new Date('2026-11-13T14:00:00-05:00'));
      await open(page);
      await page.addStyleTag({ content: '.si23 *, .si23 *::before, .si23 *::after {animation:none!important;transition:none!important}' });
      await capture(page, '01-signin', size);
      await tapTargets(page);
      expect((await new AxeBuilder({ page }).include('.si23').analyze()).violations).toEqual([]);
      await expect(page.getByRole('button', { name: /Continue with a passkey/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeDisabled();
      await page.getByLabel('Email or CurrencyDesk ID').fill('cd york 7k42');
      await page.keyboard.press('Tab');
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
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
      await capture(page, '02-password-wrong', size);
      expect((await new AxeBuilder({ page }).include('.si23').analyze()).violations).toEqual([]);
      await tapTargets(page);
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
  test('production URLs cannot activate the capture composition or serve the prototype', async ({ page }) => {
    expect((await page.request.get('/tests/fixtures/signin-v23/prototype.html')).status()).toBe(404);
    expect((await page.request.get('/__signin-reference__/')).status()).toBe(404);
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
    await expect(page.getByRole('status')).toContainText('Checking');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'false');
    expect(await page.getByRole('status').evaluate(e => e.classList.contains('si23-err'))).toBe(false);
    release();
    await expect(page.getByText('Check your email', { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    await page.getByRole('button', { name: '← Back', exact: true }).click();
    await expect(page.getByText(/Another code in \d+s/)).toHaveAttribute('aria-live', 'off');
    await expect(page.getByRole('button', { name: 'Continue →' })).toBeDisabled();
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
  for (const staffId of ['maryjane', 'adam-west', 'cdbeckham7']) {
    test(`ID-shaped legacy username ${staffId} signs in without rewriting`, async ({ page }) => {
      const temp = 'disposable-first-password', password = 'disposable-changed-password';
      expect((await page.request.post('/api/auth/login', { data: { staffId: 'r.haddad', password: 'yorkville' } })).status()).toBe(200);
      expect((await page.request.post('/api/staff', { data: { staffId, name: 'Synthetic Login', role: 'teller', password: temp } })).status()).toBe(201);
      await page.context().clearCookies();
      expect((await page.request.post('/api/auth/login', { data: { staffId, password: temp } })).status()).toBe(200);
      expect((await page.request.post('/api/auth/change-password', { data: { currentPassword: temp, newPassword: password } })).status()).toBe(200);
      await page.context().clearCookies();
      await open(page);
      await page.getByLabel('Email or CurrencyDesk ID').pressSequentially(staffId);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.locator('.si23-who-id b')).toHaveText(staffId);
      await page.getByLabel('Password', { exact: true }).fill(password);
      const response = page.waitForResponse('**/api/auth/login/start');
      await page.getByRole('button', { name: 'Continue →' }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      expect(result.request().postDataJSON().staffId).toBe(staffId);
      expect((await (await page.request.get('/api/auth/me')).json()).user.id).toBe(staffId);
    });
  }
  test('typing a real server-issued legacy CD-ID signs in', async ({ page }) => {
    await signInAsOperator(page);
    const issued = await page.request.post('/api/admin/staff/tnt-yorkfx%3Am.costa/cd-id');
    expect(issued.status()).toBe(200);
    const { cdId } = await issued.json();
    expect(cdId).toMatch(/^CD-[A-Z]{2,6}-\d{4,}$/);
    await page.context().clearCookies();
    await open(page);
    await page.getByLabel('Email or CurrencyDesk ID').pressSequentially(cdId.toLowerCase());
    await page.keyboard.press('Enter');
    await page.getByLabel('Password', { exact: true }).fill('yorkville');
    const response = page.waitForResponse('**/api/auth/login/start');
    await page.getByRole('button', { name: 'Continue →' }).click();
    expect((await response).status()).toBe(200);
    expect((await (await page.request.get('/api/auth/me')).json()).user.id).toBe('m.costa');
  });
});
