import { test, expect } from '@playwright/test';

test('native paste preserves ID privacy and code entry', async ({page,context}) => {
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 const lookups:string[]=[];page.on('request',r=>{if(r.url().includes('/api/signup/lookup'))lookups.push(r.url());});
 await page.goto('/onboarding');await page.getByRole('button',{name:/^Start/}).click();
 const id=page.getByPlaceholder('CD-YORK-7K42');await expect(id).toBeFocused();
 await page.evaluate(()=>navigator.clipboard.writeText('cdyork'));await id.press('ControlOrMeta+V');
 await expect(id).toHaveValue('CD-YORK');await page.waitForTimeout(450);expect(lookups).toEqual([]);
 await page.goto('/onboarding?step=inbox');const code=page.getByLabel('6-digit code');await expect(code).toBeFocused();
 await expect(code).toHaveAttribute('autocomplete','one-time-code');await expect(code).toHaveAttribute('inputmode','numeric');
 await page.evaluate(()=>navigator.clipboard.writeText('48'));await code.press('ControlOrMeta+V');await expect(code).toHaveValue('48');
});

test('password-manager fields accept filled values and retain focus during state updates', async ({page}) => {
 await page.goto('/onboarding?step=signin');await page.getByRole('button',{name:'Continue with email and password'}).click();
 const first=page.getByPlaceholder('At least 12 characters'),again=page.getByPlaceholder('Same again');
 await expect(first).toBeFocused();await expect(first).toHaveAttribute('autocomplete','new-password');await expect(again).toHaveAttribute('autocomplete','new-password');
 await first.fill('synthetic long passphrase');await again.fill('synthetic long passphrase');await expect(again).toBeFocused();
 await expect(page.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>Object.values(localStorage).join(' '))).not.toContain('synthetic long passphrase');
});
