import { chromium } from '@playwright/test';
const SHOT = '/tmp/claude-0/-home-user-Currency-desk-OS/5d73e616-e44d-549d-afa2-fda601cc206f/scratchpad/shots';
import fs from 'fs';
fs.mkdirSync(SHOT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE ERR:', m.text().slice(0, 300)); });
page.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 300)));

await page.goto('http://127.0.0.1:8871/app', { waitUntil: 'networkidle' });
const r = await page.evaluate(async () => {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staffId: 'a.singh', password: 'yorkville', tenantId: 'tnt-yorkfx' }) });
  return { s: res.status, b: (await res.text()).slice(0, 200) };
});
console.log('login', JSON.stringify(r));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
await page.screenshot({ path: SHOT + '/01-landing.png', fullPage: false });
console.log('TITLE', await page.title());
console.log('BODYTEXT', (await page.evaluate(() => document.body.innerText)).slice(0, 2000));
await ctx.storageState({ path: '/tmp/claude-0/-home-user-Currency-desk-OS/5d73e616-e44d-549d-afa2-fda601cc206f/scratchpad/state.json' });
await browser.close();
