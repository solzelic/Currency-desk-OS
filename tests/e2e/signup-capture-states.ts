/* The pack's complete 38-state inventory, shared by accessibility evidence. */
import type { Page } from '@playwright/test';
export type Actions = { fill:(selector:string,value:string)=>Promise<void>;typeIn:(selector:string,value:string)=>Promise<void>;click:(label:string)=>Promise<void>;wait:(ms:number)=>Promise<void> };
export const SIGNUP_STATES: [string, number, string, ((a: Actions) => Promise<void>)?][] = [
  ['01-welcome', 0, 'welcome'],
  ['02-id-empty', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); }],
  ['02-id-typing', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.typeIn('input[placeholder="CD-YORK-7K42"]', 'cdyork'); }],
  ['02-id-valid', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.typeIn('input[placeholder="CD-YORK-7K42"]', 'cd york 7k42'); }],
  ['02-id-resend', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.click('Can’t find your ID?'); }],
  ['02-id-resend-sent', 1, 'id', async (a) => { await a.fill('input[placeholder="CD-YORK-7K42"]', ''); await a.click('Can’t find your ID?'); await a.typeIn('input[type="email"]', 'daniel@yorkcurrency.ca'); await a.click('Send my ID'); }],
  ['03-chapter1', 2, 'chapter1'],
  ['04-signin', 3, 'signin'],
  ['04-signin-passkey', 4, 'signin-passkey'],
  ['04-signin-google', 5, 'signin-google'],
  ['04-signin-cancelled', 6, 'signin-cancelled'],
  ['05-inbox', 7, 'inbox'],
  ['05-inbox-typing', 7, 'inbox', async (a) => { await a.typeIn('input[autocomplete="one-time-code"]', '48'); }],
  ['06-pin-intro', 8, 'pin-intro'],
  ['07-pin', 9, 'pin'],
  ['08-shop-name', 10, 'shop-name'],
  ['09-address', 11, 'address'],
  ['10-shops', 12, 'shops'],
  ['11-shops-more', 13, 'shops-more'],
  ['12-registration', 14, 'registration'],
  ['13-money', 15, 'money'],
  ['14-currencies', 16, 'currencies'],
  ['15-count', 17, 'count'],
  ['15-count-total', 17, 'count', async (a) => { await a.click('Type the total'); }],
  ['16-online', 18, 'online'],
  ['17-rules', 19, 'rules'],
  ['18-officer', 20, 'officer'],
  ['19-idline-law', 21, 'idline'],
  ['19-idline', 21, 'idline', async (a) => { await a.wait(6500); }],
  ['20-team', 22, 'team'],
  ['21-add-person', 23, 'add-person'],
  ['22-confirm', 24, 'confirm'],
  ['23-confirmed', 25, 'confirmed'],
  ['24-pay-plan', 26, 'pay'],
  ['24-pay-extras', 26, 'pay', async (a) => { await a.click('Extras'); }],
  ['24-pay-payment', 26, 'pay', async (a) => { await a.click('Payment'); }],
  ['24-pay-agreement', 26, 'pay', async (a) => { await a.click('The agreement'); }],
  ['25-day1', 27, 'day1', async (a) => { await a.wait(2500); }],
];
export function actions(page:Page):Actions {
 return {
  wait:ms=>page.waitForTimeout(ms),
  fill:async(selector,value)=>{await page.locator(selector).first().fill(value);await page.waitForTimeout(350);},
  typeIn:async(selector,value)=>{await page.locator(selector).first().pressSequentially(value,{delay:40});await page.waitForTimeout(500);},
  click:async(label)=>{
   const found=await page.evaluate(label=>{
    const candidates=[...document.querySelectorAll<HTMLElement>('button,a,[role="button"],[role="checkbox"],[role="option"]')].filter(e=>e.offsetParent&&!e.closest('[data-review]'));
    const text=(e:HTMLElement)=>e.innerText.replace(/\s+/g,' ').trim();
    const el=candidates.find(e=>text(e)===label)||candidates.find(e=>text(e).startsWith(label))||candidates.find(e=>text(e).includes(label));
    el?.click();return !!el;
   },label);
   if(!found)throw Error('State setup control missing: '+label);await page.waitForTimeout(650);
  }
 };
}
