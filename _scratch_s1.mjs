import { open, save, txt } from './_scratch_lib.mjs';
const { browser, ctx, page, shot } = await open('s1');

// Open the till
await page.getByText('Open Till', { exact: false }).first().click();
await page.waitForTimeout(1800);
await shot('a-till');
console.log('--- TILL SCREEN ---');
console.log((await txt(page)).slice(0, 3000));
await save(ctx);
await browser.close();
