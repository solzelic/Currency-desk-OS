import { readFileSync } from 'node:fs';
import { test, expect, rendered } from './fixtures';

// Only walk the existing application screens this copy change owns. No
// enquiry is submitted and no provisioning, waitlist or v2 flow is simulated.
for (const width of [1280, 390]) {
  test(`Early Access owner copy preserves phone and call-time requirements at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const settleCard = () => page.locator('div[style*="cdCardIn"]').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST') writes.push(request.url());
    });
    await page.goto('/signup');
    await rendered(page, 'Run the whole exchange');
    await page.getByRole('button', { name: 'Apply for early access' }).click();
    await page.getByPlaceholder('you@yourexchange.com').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Apply for early access' }).click();
    await page.getByRole('button', { name: "I don't have a website yet" }).click();
    await page.getByLabel('What the shop is called').fill('Example test shop');
    await page.getByRole('button', { name: 'Reserve it' }).click();
    await page.getByRole('button', { name: /Under \$500K/ }).click();
    const next = page.getByRole('button', { name: 'Continue', exact: true });
    await next.click();
    await page.getByRole('button', { name: /^Spreadsheets & manual logs/ }).click();
    await next.click();
    await page.getByRole('button', { name: /As soon as possible/ }).click();
    await next.click();
    const mobile = page.getByRole('heading', { name: "What's your mobile number?", exact: true });
    await expect(mobile).toBeVisible();
    await expect(page.getByText('If we approve you, we call. The call is mostly us listening, and we follow up once the desk is in your hands.', { exact: true })).toBeVisible();
    await settleCard();
    await page.screenshot({ path: testInfo.outputPath(`mobile-${width}.png`), fullPage: true });
    await next.click();
    await expect(mobile).toBeVisible();
    const phone = page.getByPlaceholder('416 555 0148');
    await phone.fill('4165550148');
    await next.click();
    await expect(mobile).toBeVisible(); // A phone alone still needs a call-time choice.
    await page.getByRole('button', { name: 'Mornings', exact: true }).click();
    await next.click();
    const name = page.getByText('Your name goes on your Founding Operator card.', { exact: true });
    await expect(name).toBeVisible();
    await settleCard();
    await page.screenshot({ path: testInfo.outputPath(`name-${width}.png`), fullPage: true });
    const back = page.locator('button').filter({ has: page.locator('path[d="M19 12H5M11 6l-6 6 6 6"]') });
    await back.click();
    await expect(phone).toHaveValue('4165550148');
    await next.click();
    await expect(name).toBeVisible(); // Call-time selection also survived Back.
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Early Access shop copy preserves option selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const settleCard = () => page.locator('div[style*="cdCardIn"]').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST') writes.push(request.url());
    });
    await page.goto('/signup');
    await rendered(page, 'Run the whole exchange');
    await page.getByRole('button', { name: 'Apply for early access' }).click();
    await page.getByPlaceholder('you@yourexchange.com').fill('owner@example.invalid');
    await page.getByRole('button', { name: 'Apply for early access' }).click();
    await page.getByRole('button', { name: "I don't have a website yet" }).click();
    await page.getByLabel('What the shop is called').fill('Example test shop');
    await page.getByRole('button', { name: 'Reserve it' }).click();
    const volume = page.getByRole('heading', { name: 'About how much do you exchange a month?' });
    await expect(volume).toBeVisible();
    await expect(page.getByText('A ballpark in Canadian dollars.', { exact: true })).toBeVisible();
    await settleCard();
    await page.screenshot({ path: testInfo.outputPath(`volume-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: /Under \$500K/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const software = page.getByRole('button', { name: /^MSB software we use/ });
    const apps = page.getByRole('button', { name: /^A mix of apps/ });
    await expect(software).toBeVisible();
    await expect(apps).toBeVisible();
    await expect(page.getByText('Legacy MSB software', { exact: true })).toHaveCount(0);
    await expect(page.getByText('A patchwork of apps', { exact: true })).toHaveCount(0);
    await settleCard();
    for (const option of [software, apps]) {
      // The entrance starts at scale(.985), briefly rendering a 44px row
      // at 43.34px. Assert its settled hit area, not that animation frame.
      await expect.poll(async () => (await option.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44);
      await option.click();
      await expect(option.getByText('✓', { exact: true })).toHaveCSS('opacity', '1');
    }
    await expect(software.getByText('✓', { exact: true })).toHaveCSS('opacity', '0');
    await page.screenshot({ path: testInfo.outputPath(`compliance-${width}.png`), fullPage: true });
    const back = page.locator('button').filter({ has: page.locator('path[d="M19 12H5M11 6l-6 6 6 6"]') });
    await back.click();
    await expect(volume).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(apps.getByText('✓', { exact: true })).toHaveCSS('opacity', '1');
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Early Access copy and back/forward navigation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/signup');
    await rendered(page, 'Run the whole exchange');
    await expect(page.getByText("We're opening the desk to a first group of shops in Canada. Apply, and we'll hold your place.")).toBeVisible();
    const legal = page.locator('p').filter({ hasText: 'By applying you agree' });
    await expect(legal).toHaveCSS('font-size', '13px');
    await expect(legal).toHaveCSS('color', 'rgb(107, 100, 89)');
    await expect(legal).toContainText('No card required.');
    await expect(legal).not.toContainText('never sell');
    await expect(legal.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('href', '/legal#terms');
    await expect(legal.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/legal#privacy');
    // CSSOM serializes shorthand timing before its name; do not depend on
    // the source order of the animation declaration in the rendered style.
    const bar = page.locator('[aria-hidden="true"][style*="cdBar"]');
    await expect(bar).toHaveCSS('animation-name', 'cdBar');
    await expect(bar).toHaveCSS('animation-duration', '9s');
    expect(await bar.evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('194, 69, 45');
    const forward = page.getByRole('button', { name: 'Apply for early access' });
    await expect(forward.locator('svg')).toBeVisible();
    await forward.click();
    await expect(page.getByPlaceholder('you@yourexchange.com')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`email-${width}.png`), fullPage: true });
    await page.getByPlaceholder('you@yourexchange.com').fill('owner@example.invalid');
    await forward.click();
    await page.getByRole('button', { name: "I don't have a website yet" }).click();
    await expect(page.getByText('Reserve your desk.', { exact: true })).toBeVisible();
    await expect(page.getByText("Your shop's address on CurrencyDesk. It's yours the moment you finish.")).toBeVisible();
    // Empty shop data keeps screenshots free of invented or customer data.
    await page.screenshot({ path: testInfo.outputPath(`address-${width}.png`), fullPage: true });
    const back = page.locator('button').filter({ has: page.locator('path[d="M19 12H5M11 6l-6 6 6 6"]') });
    const box = await back.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(page.getByRole('button', { name: "I don't have a website yet" })).toBeVisible();
    await back.click();
    await expect(page.getByPlaceholder('you@yourexchange.com')).toHaveValue('owner@example.invalid');
    await forward.click();
    await page.getByRole('button', { name: "I don't have a website yet" }).click();
    await expect(page.getByText('Reserve your desk.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// Isolated browser canvas smoke: execute the shipped callback with synthetic
// state. This does not exercise signup, server acceptance or the reveal.
test('Early Access certificate draws and exports a PNG without unsigned claims', async ({ page }, testInfo) => {
  const html = readFileSync('web/early-access.html', 'utf8');
  const body = html.match(/download = async \(\) => \{([\s\S]*?)\n  \};\n  share =/)?.[1];
  expect(body).toBeTruthy();
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.setContent('<!doctype html><title>Isolated certificate smoke</title>');
  const result = await page.evaluate(async callback => {
    const text: string[] = [], messages: string[] = [];
    let png = '', filename = '', clicks = 0;
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    const originalClick = HTMLAnchorElement.prototype.click;
    CanvasRenderingContext2D.prototype.fillText = function(value, x, y, maxWidth?) {
      text.push(value);
      if (maxWidth === undefined) originalText.call(this, value, x, y);
      else originalText.call(this, value, x, y, maxWidth);
    };
    HTMLAnchorElement.prototype.click = function() { png = this.href; filename = this.download; clicks++; };
    try {
      const download = new Function('return async function () {' + callback + '\n}')();
      await download.call({ state: { name: 'Example Operator', memberCount: 42 },
        _workspaceFull: () => 'example.invalid', _joinDate: () => 'Nov 12, 2026',
        _jurName: () => 'Canada', flashToast: (message: string) => messages.push(message) });
      const image = new Image(); image.src = png; await image.decode();
      return { text, messages, png, filename, clicks, width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = originalText;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  }, body!);
  expect(result.text.join('\n')).not.toMatch(/certifies that|first one hundred|to run their counter|O F\s+1 0 0|held for life/i);
  for (const field of ['Example Operator', 'Nº 0042', 'example.invalid', 'Nov 12, 2026', 'Canada']) expect(result.text).toContain(field);
  expect(result.width).toBe(1240); expect(result.height).toBe(1754);
  expect(result.png).toMatch(/^data:image\/png;base64,/);
  expect(result.filename).toBe('CurrencyDesk-Founding-Operator-0042.png');
  expect(result.clicks).toBe(1);
  expect(result.messages).toEqual(['Certificate Nº 0042 downloaded.']);
  expect(writes).toEqual([]);
  await testInfo.attach('synthetic-certificate.png', { body: Buffer.from(result.png.split(',')[1], 'base64'), contentType: 'image/png' });
});
