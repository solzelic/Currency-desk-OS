import { test, expect } from '@playwright/test';
test('signup opens and accepts typing with browser code compilation disabled', async ({ page }) => {
  const runtime: string[] = [];
  page.on('request', r => { if (/support\.js|babel|unpkg/.test(r.url())) runtime.push(r.url()); });
  await page.addInitScript(() => {
    window.Function = new Proxy(window.Function, { construct() { throw new Error('Browser compilation forbidden'); }, apply() { throw new Error('Browser compilation forbidden'); } });
  });
  await page.goto('/onboarding');
  await expect(page.getByText('Welcome. Let’s open your desk.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Start/ }).click();
  const id = page.getByPlaceholder('CD-YORK-7K42');
  await id.fill('cdtest');
  await expect(id).toHaveValue('CD-TEST');
  expect(runtime).toEqual([]);
});

test('the seeded ID remains renderable after clearing and typing it again', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/onboarding?step=id');
  const id = page.getByPlaceholder('CD-YORK-7K42');
  await id.fill(''); await id.fill('cdyork7k42');
  await expect(page.getByRole('button', { name: /^Open it/ })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a disabled Open button keeps its disabled appearance on hover', async ({ page }) => {
  await page.goto('/onboarding?step=pay');
  const open = page.getByRole('button', { name: /^Open York/ });
  await expect(open).toBeDisabled();
  await page.mouse.move(0, 0);
  const background = await open.evaluate(e => getComputedStyle(e).backgroundColor);
  await open.hover({ force: true });
  await expect(open).toHaveCSS('background-color', background);
});
