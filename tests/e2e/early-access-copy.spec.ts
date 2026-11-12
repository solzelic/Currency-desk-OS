import { test, expect, rendered } from './fixtures';

// Only walk the existing application screens this copy change owns. No
// enquiry is submitted and no provisioning, waitlist or v2 flow is simulated.
for (const width of [1280, 390]) {
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
