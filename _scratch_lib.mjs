import { chromium } from '@playwright/test';
import fs from 'fs';
export const SP = '/tmp/claude-0/-home-user-Currency-desk-OS/5d73e616-e44d-549d-afa2-fda601cc206f/scratchpad';
export const SHOT = SP + '/shots';
fs.mkdirSync(SHOT, { recursive: true });

export async function open(name) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: SP + '/state.json' });
  ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGE ERR:', String(e).slice(0, 200)));
  await page.goto('http://127.0.0.1:8871/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return { browser, ctx, page, shot: async (n) => { await page.screenshot({ path: `${SHOT}/${name}-${n}.png` }); console.log('shot', `${name}-${n}`); } };
}
export async function save(ctx) { await ctx.storageState({ path: SP + '/state.json' }); }
export const txt = (page) => page.evaluate(() => document.body.innerText);
