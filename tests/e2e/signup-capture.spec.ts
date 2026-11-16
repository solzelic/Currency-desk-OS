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
