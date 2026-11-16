import { test, expect } from '@playwright/test';
import measureSignup from '../../scripts/signup-capture-measure.cjs';

test('capture measures visible labelled controls, excluding closed details and hidden ancestors', async ({ page }) => {
  await page.setContent('<details><summary>Account</summary><button><span>Sound on</span></button></details><button><span>Continue</span></button><button aria-label="Close"><svg width="20" height="20"></svg></button><div style="visibility:hidden"><button>Hidden</button></div><div style="opacity:0"><button>Transparent</button></div>');
  const first = await page.evaluate(measureSignup);
  expect(first.elements.filter(e => e.tag === 'button').map(e => e.text)).toEqual(['Continue', 'Close']);
  await page.locator('summary').click();
  const second = await page.evaluate(measureSignup);
  expect(second.elements.filter(e => e.tag === 'button').map(e => e.text)).toEqual(['Sound on', 'Continue', 'Close']);
});

test('capture detects overflow inside the fixed product viewport', async ({ page }) => {
  await page.setContent('<style>body{margin:0}</style><main data-product style="position:fixed;inset:0;overflow:auto"><div style="height:200vh">Content</div></main>');
  const overflow = await page.evaluate(measureSignup);
  expect(overflow.documentScrolls).toBe(false);
  expect(overflow.productScrolls).toBe(true);
  expect(overflow.pageScrolls).toBe(true);
  await page.locator('[data-product]>div').evaluate(e => e.style.height = '50vh');
  expect((await page.evaluate(measureSignup)).pageScrolls).toBe(false);
});
