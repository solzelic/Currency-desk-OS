import { test, expect, landOnDesktop } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { Pool } = createRequire(path.join(process.cwd(), 'server/package.json'))('pg');
const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL });
const synthetic = 'owner+1234abcd@staging.invalid';
const reply = (code: unknown = '123456', id = synthetic) => ({ ok: true, needsCode: true, code,
  maskedEmail: 'o•••@staging.invalid', user: { id, tenantId: 'tnt-stg-1234abcd', role: 'administrator', name: 'Test owner' } });
const shown = (page: Page) => page.getByRole('status', { name: 'Staging test code' });
async function password(page: Page, id = synthetic, url = '/login') {
  await page.goto(url);
  await page.getByPlaceholder('your-staff-id').fill(id);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.locator('input[type="password"]').fill('cedar ferry orbit 921!');
}
async function send(page: Page) { await page.locator('form button[type="submit"]').click(); }
async function digits(page: Page, code: string, touch = false) {
  for (const digit of code) {
    const key = page.getByRole('button', { name: digit, exact: true });
    if (touch) await key.tap(); else { await key.focus(); await page.keyboard.press('Enter'); }
  }
}
test.afterAll(async () => { await pool.end(); });

async function realLogin(page: Page, method: 'password' | 'code') {
  if (method === 'password') {
    await password(page, 'm.costa');
    await page.locator('input[type="password"]').fill('yorkville');
    return { code: '', email: 'm.costa' };
  }
  await pool.query("INSERT INTO db_environment (environment) SELECT 'staging' WHERE NOT EXISTS (SELECT 1 FROM db_environment)");
  const owner = await freshOwner(page);
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await password(page, owner.cdId); await send(page);
  await expect(shown(page)).toBeVisible();
  return { code: (await shown(page).locator('output').innerText()).trim(), email: owner.email };
}

for (const method of ['password', 'code'] as const) {
  test(`real ${method} success cannot be hidden by pending navigation`, async ({ page }, info) => {
    const account = await realLogin(page, method);
    const endpoint = method === 'code' ? '**/api/auth/login/verify' : '**/api/auth/login/start';
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    await page.route(endpoint, async route => { await gate; await route.continue(); });
    try {
      if (method === 'code') await digits(page, account.code); else await send(page);
      const back = page.getByRole('button', { name: method === 'code' ? '← Back' : 'not you?', exact: true });
      await expect(back).toBeDisabled();
      // Reach the actual handler too: disabled HTML alone does not prove the latch.
      await back.evaluate((b: HTMLButtonElement) => { b.disabled = false; b.click(); });
      await expect(page.getByPlaceholder('your-staff-id')).toHaveCount(0);
      if (method === 'code') await expect(shown(page)).toBeVisible();
      await page.screenshot({ path: info.outputPath(`pending-${method}.png`) });
      const response = page.waitForResponse(endpoint); release();
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
      expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(200);
    } finally { release(); }
  });

  test(`unmounted real ${method} success revokes its session`, async ({ page }) => {
    // Capture the real application's root, without changing SignIn or the server.
    await page.route('**/web/vendor/react-dom.production.min.js', async route => {
      await route.fulfill({ contentType: 'application/javascript', body: readFileSync('web/vendor/react-dom.production.min.js', 'utf8') + '\nconst originalRoot=ReactDOM.createRoot;ReactDOM.createRoot=(...args)=>{const root=originalRoot(...args);window.__signinTestRoot=root;return root;};' });
    });
    const account = await realLogin(page, method);
    const endpoint = method === 'code' ? '**/api/auth/login/verify' : '**/api/auth/login/start';
    let release = () => {};
    const gate = new Promise<void>(r => { release = r; });
    await page.route(endpoint, async route => { await gate; await route.continue(); });
    try {
      if (method === 'code') await digits(page, account.code); else await send(page);
      await page.evaluate('window.__signinTestRoot.unmount()');
      const response = page.waitForResponse(endpoint); release();
      expect((await response).status()).toBe(200);
      // Cleanup must reset the visible application itself, without a test reload.
      await expect(page).toHaveURL(/\/app$/);
      await expect(page.getByPlaceholder('your-staff-id')).toBeVisible();
      expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(401);
    } finally { release(); }
  });
}


for (const action of ['initial', 'resend'] as const) test(`code-required ${action} preserves the session adopted by real boot resume`, async ({ page }, info) => {
  await pool.query("INSERT INTO db_environment (environment) SELECT 'staging' WHERE NOT EXISTS (SELECT 1 FROM db_environment)");
  const owner = await freshOwner(page);
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  const existing = await page.evaluate(() => fetch('/api/auth/login/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffId: 'm.costa', password: 'yorkville' }),
  }).then(r => r.json()));
  expect(existing.needsCode).toBe(false);
  let holdMe = true, releaseMe = () => {}, releaseIssue = () => {}, starts = 0, logouts = 0;
  const meGate = new Promise<void>(r => { releaseMe = r; });
  const issueGate = new Promise<void>(r => { releaseIssue = r; });
  await page.route('**/api/auth/me', async route => { if (holdMe) await meGate; await route.continue(); });
  await page.route('**/api/auth/login/start', async route => {
    if (++starts === 1 && action === 'resend') {
      // Seed only the initial keypad presentation, avoiding a real two-minute
      // cooldown. The held resend below uses the real server, proof and cookie.
      // This synthetic initial code cannot authenticate and is never submitted.
      await route.fulfill({ json: { ...reply('123456', owner.email), user: { ...reply().user, id: owner.email, tenantId: owner.tenantId } } });
      return;
    }
    await issueGate; await route.continue();
  });
  page.on('request', r => { if (r.url().endsWith('/api/auth/logout')) logouts++; });
  await page.clock.install();
  try {
    await password(page, owner.cdId, '/app'); await send(page);
    if (action === 'resend') {
      await expect(shown(page)).toBeVisible();
      await page.clock.fastForward(121000);
      await page.getByRole('button', { name: 'Resend', exact: true }).click();
    }
    holdMe = false; releaseMe();
    // This is the product's boot resume, with no root-unmount or React hook.
    await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
    await expect(page.getByPlaceholder('your-staff-id')).toHaveCount(0);
    const response = page.waitForResponse('**/api/auth/login/start'); releaseIssue();
    const issued = await response;
    expect(issued.status()).toBe(200);
    // The real route issued a proof, not a session. Read the database rather
    // than CDP's body: the broken client abandons that body before reading it.
    expect((await pool.query('SELECT count(*)::int AS n FROM login_challenges WHERE user_id = (SELECT id FROM staff_users WHERE staff_id = $1)', [owner.email])).rows[0].n).toBe(1);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const me = await page.evaluate(() => fetch('/api/auth/me').then(async r => ({ status: r.status, body: await r.json() })));
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe('m.costa');
    expect(logouts).toBe(0);
    await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`resume-after-${action}.png`) });
    expect((await pool.query('SELECT count(*)::int AS n FROM login_challenges WHERE user_id = (SELECT id FROM staff_users WHERE staff_id = $1)', [owner.email])).rows[0].n).toBe(1);
  } finally { holdMe = false; releaseMe(); releaseIssue(); }
});

test('real contention keeps the code and allows immediate manual retry', async ({ page }, info) => {
  const account = await realLogin(page, 'code');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT token_hash FROM login_challenges WHERE user_id = (SELECT id FROM staff_users WHERE staff_id = $1) FOR UPDATE', [account.email]);
    expect(locked.rowCount).toBe(1);
    const response = page.waitForResponse('**/api/auth/login/verify');
    await digits(page, account.code);
    expect((await response).status()).toBe(503);
    await expect(shown(page)).toContainText(account.code);
    await expect(page.getByText(/^Sign-in is having trouble\. Try this code again in a moment\.$/i)).toBeVisible();
    expect((await client.query('SELECT attempts FROM login_challenges WHERE user_id = (SELECT id FROM staff_users WHERE staff_id = $1)', [account.email])).rows[0].attempts).toBe(0);
    await page.screenshot({ path: info.outputPath('retryable-code-503.png') });
    await client.query('ROLLBACK');
    await digits(page, account.code);
    await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
    expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(200);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

for (const cleanup of ['refused', 'hung']) test(`unconfirmed ${cleanup} logout visibly resolves the real session`, async ({ page }) => {
  await page.route('**/web/vendor/react-dom.production.min.js', route => route.fulfill({ contentType: 'application/javascript',
    body: readFileSync('web/vendor/react-dom.production.min.js', 'utf8') + '\nconst originalRoot=ReactDOM.createRoot;ReactDOM.createRoot=(...args)=>{const root=originalRoot(...args);window.__signinTestRoot=root;return root;};' }));
  await realLogin(page, 'password');
  let releaseLogin = () => {}, releaseLogout = () => {};
  const loginGate = new Promise<void>(r => { releaseLogin = r; });
  const logoutGate = new Promise<void>(r => { releaseLogout = r; });
  await page.route('**/api/auth/login/start', async route => { await loginGate; await route.continue(); });
  await page.route('**/api/auth/logout', async route => {
    if (cleanup === 'hung') { await logoutGate; await route.abort().catch(() => {}); }
    else await route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  try {
    await send(page);
    await page.evaluate('window.__signinTestRoot.unmount()');
    releaseLogin();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
    expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(200);
    await expect(page.getByPlaceholder('your-staff-id')).toHaveCount(0);
  } finally { releaseLogin(); releaseLogout(); }
});

// Public ticket/application and real signup endpoints; no fabricated provenance or proof.
async function freshOwner(page: Page) {
  await page.goto('/login');
  return page.evaluate(async () => {
    const call = async (url: string, data?: object, method = 'POST') => {
      const r = await fetch(url, { method, ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) });
      if (!r.ok) throw new Error(`fixture ${url}: ${r.status}`);
      return r.json();
    };
    const door = await call('/api/staging/fresh-onboarding');
    const applied = await call('/api/enquiries', { kind: 'early_access', form: 'early-access-v2.1', email: 'typed@example.com', name: 'Staging Owner', stagingDoor: new URL(door.start, location.origin).searchParams.get('door'),
      details: { firstName: 'Staging', lastName: 'Owner', shopName: 'Harbour Test', workspace: 'harbour-test.currencydeskos.com', website: 'none yet', mode: 'early_access', jurisdiction: 'CA', province: 'ON', country: 'Canada', state: null, fintracRegistered: 'Yes', msbNumber: null, waitlist: false, waitlistReason: null, role: 'Owner', employees: '2 to 5', monthlyVolume: '$2M to $10M', branches: 'single', runningOn: 'Spreadsheets', timeline: 'This quarter', phone: '+1 4165550148', bestTime: 'no call', samConsent: null }, contactContext: { timezone: 'America/Toronto' } });
    const base = `/api/onboarding/${applied.cdId}`;
    const saved = await call(`${base}/password`, { password: 'cedar ferry orbit 921!', confirm: 'cedar ferry orbit 921!' });
    await call(`${base}/email/verify`, { code: saved.stagingCode });
    await call(`${base}/pin`, { pin: '4821', confirm: '4821' });
    for (const [step, answers] of [
      ['08-shop-name', { operatingName: 'Harbour Test', bizName: 'Harbour Test Inc.' }],
      ['09-address', { street: '1420 Dundas St W', city: 'Toronto', region: 'ON', postal: 'M6J 1Y5', addrManual: true }],
      ['14-currencies', { currencies: ['USD', 'EUR'] }], ['18-officer', { complianceMode: 'me' }],
      ['19-idline', { idOver: '1000' }], ['20-team', { team: [] }],
    ]) await call(`${base}/answers`, { step, answers }, 'PUT');
    await call(`${base}/confirm`, { signed: true, name: 'Staging Owner' });
    const pay = await call(`${base}/payment`, { plan: 'ai', term: 'monthly', extras: { brief: true, call: false, website: false, setupWeek: false } });
    await call(`${base}/staging-open`, { agreed: true, termsSourceHash: pay.termsSourceHash });
    const opened = await call(`${base}/open`);
    return { email: door.email, cdId: applied.cdId, tenantId: opened.tenantId };
  });
}

for (const width of [1440, 390]) test(`real signup, logout and manual returning code at ${width}`, async ({ browser, baseURL }, info) => {
  await pool.query("INSERT INTO db_environment (environment) SELECT 'staging' WHERE NOT EXISTS (SELECT 1 FROM db_environment)");
  const context = await browser.newContext({ baseURL, viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 });
  const page = await context.newPage();
  const messages: string[] = [];
  page.on('console', m => messages.push(m.text()));
  const owner = await freshOwner(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
  await landOnDesktop(page);
  expect(await page.evaluate(() => fetch('/api/tenant').then(r => r.status))).toBe(200);
  expect(await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }).then(r => r.status))).toBe(200);
  await password(page, owner.cdId); // canonical ID must resolve to the synthetic email
  let verifies = 0;
  page.on('request', r => { if (r.url().endsWith('/api/auth/login/verify')) verifies++; });
  await send(page);
  await expect(shown(page)).toBeVisible();
  const code = (await shown(page).locator('output').innerText()).trim();
  expect(/^\d{6}$/.test(code)).toBe(true);
  expect(verifies).toBe(0);
  expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(401);
  await expect(page.getByText('Check your email', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`staging-code-${width}.png`), fullPage: true });
  expect(await page.evaluate(c => JSON.stringify([localStorage, sessionStorage]).includes(c), code)).toBe(false);
  expect(messages.some(m => m.includes(code))).toBe(false);
  await digits(page, code, width === 390);
  await expect(shown(page)).toHaveCount(0);
  const me = await page.evaluate(() => fetch('/api/auth/me').then(r => r.json()));
  expect(me.user.tenantId).toBe(owner.tenantId);
  expect(me.user.id).toBe(owner.email);
  expect(verifies).toBe(1);
  await expect(page.getByRole('heading', { name: /Where are you working/i })).toBeVisible();
  await landOnDesktop(page);
  await page.screenshot({ path: info.outputPath(`returned-desk-${width}.png`), fullPage: true });
  await context.close();
});

test('resend replaces the displayed code; failures and terminal verification clear it', async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  await page.route('**/api/auth/login/start', r => r.fulfill({ status: ++calls === 3 ? 503 : 200, json: reply(calls === 1 ? '123456' : '654321') }));
  await password(page); await send(page);
  await expect(shown(page)).toContainText('123456');
  await page.clock.fastForward(121000);
  await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(shown(page)).toContainText('654321');
  await expect(page.getByText('123456', { exact: true })).toHaveCount(0);
  await page.route('**/api/auth/login/verify', r => r.fulfill({ status: 410, json: { error: 'expired' } }));
  await digits(page, '654321');
  await expect(shown(page)).toHaveCount(0);
  await page.clock.fastForward(121000);
  await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(shown(page)).toHaveCount(0);
  await expect(page.getByText('A new code is on its way.', { exact: true })).toHaveCount(0);
});

for (const fault of ['failure', 'malformed', 'wrong identity']) test(`resend clears a visible code on ${fault}`, async ({ page }) => {
  await page.clock.install();
  let calls = 0;
  await page.route('**/api/auth/login/start', r => r.fulfill({
    status: ++calls > 1 && fault === 'failure' ? 503 : 200,
    json: calls === 1 ? reply() : reply(fault === 'malformed' ? 'bad' : '654321', fault === 'wrong identity' ? 'owner+8765abcd@staging.invalid' : synthetic),
  }));
  await password(page); await send(page); await expect(shown(page)).toBeVisible();
  await page.clock.fastForward(121000); await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(page.getByText('Requesting a new code…', { exact: true })).toHaveCount(0);
  await expect(shown(page)).toHaveCount(0);
  await expect(page.getByText('A new code is on its way.', { exact: true })).toHaveCount(0);
});

for (const scenario of ['ordinary', 'closed door', 'live host with URL flag', 'malformed', 'numeric code', 'failure', 'missing user', 'not ok']) test(`does not disclose: ${scenario}`, async ({ page, baseURL }) => {
  const data = reply(scenario === 'malformed' ? '1234567' : '123456', scenario === 'ordinary' ? 'ordinary@example.test' : synthetic);
  if (scenario === 'missing user') delete (data as any).user;
  if (scenario === 'numeric code') data.code = 123456;
  if (scenario === 'not ok') data.ok = false;
  if (scenario === 'closed door') await page.route('**/api/staging/signin', r => r.fulfill({ json: { enabled: false } }));
  await page.route('**/api/auth/login/start', r => r.fulfill({ status: scenario === 'failure' ? 503 : 200, json: data }));
  await password(page, data.user?.id || synthetic, scenario === 'live host with URL flag' ? `http://127.0.0.1:${new URL(baseURL!).port}/login?staging=1` : '/login'); await send(page);
  await expect(page.getByText(/Checking…/)).toHaveCount(0);
  await expect(shown(page)).toHaveCount(0);
  await expect(page.getByText('123456', { exact: true })).toHaveCount(0);
  if (scenario === 'ordinary') await expect(page.getByText('Check your email', { exact: true })).toBeVisible();
});

test('pending initial and resend replies keep their identity and navigation', async ({ page }) => {
  await page.clock.install();
  let release!: () => void;
  const held = () => new Promise<void>(r => { release = r; });
  let gate = held();
  await page.route('**/api/auth/login/start', async r => { await gate; await r.fulfill({ json: reply() }); });
  await password(page); await send(page);
  await expect(page.getByRole('button', { name: 'not you?' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send yourself a reset code' })).toBeDisabled();
  const initial = page.waitForResponse('**/api/auth/login/start');
  release(); await initial;
  await expect(shown(page)).toBeVisible();
  await page.clock.fastForward(121000);
  gate = held();
  await page.getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(shown(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '← Back', exact: true })).toBeDisabled();
  const resent = page.waitForResponse('**/api/auth/login/start');
  release(); await resent;
  await expect(shown(page)).toBeVisible();
});

test('pending resend blocks manual verification synchronously', async ({ page }) => {
  await page.clock.install();
  let calls = 0, verifies = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await page.route('**/api/auth/login/start', async r => { if (++calls > 1) await gate; await r.fulfill({ json: reply() }); });
  await page.route('**/api/auth/login/verify', r => { verifies++; return r.fulfill({ status: 401, json: { error: 'bad_code' } }); });
  await password(page); await send(page);
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await page.clock.fastForward(121000);
  await digits(page, '12345');
  // Dispatch within one turn, before React can repaint disabled buttons.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#lock button')];
    buttons.find(b => b.textContent === 'Resend')!.click();
    buttons.find(b => b.textContent === '6')!.click();
  });
  const pending = page.waitForResponse('**/api/auth/login/start'); release(); await pending;
  expect(verifies).toBe(0);
  expect(calls).toBe(2);
});

test('one verify at a time; Back is blocked until verification settles', async ({ page }) => {
  let verifies = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  await page.route('**/api/auth/login/start', r => r.fulfill({ json: reply() }));
  await page.route('**/api/auth/login/verify', async r => { verifies++; await gate; await r.fulfill({ json: { ok: true, user: reply().user } }); });
  await password(page); await send(page);
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeVisible();
  await digits(page, '12345');
  await page.getByRole('button', { name: '6', exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(page.getByText('VERIFYING…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '← Back', exact: true })).toBeDisabled();
  const response = page.waitForResponse('**/api/auth/login/verify'); release(); await (await response).finished();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(verifies).toBe(1);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(shown(page)).toHaveCount(0);
});
