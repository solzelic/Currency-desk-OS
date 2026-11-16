import axe from 'axe-core';
import { SIGNUP_STATES, actions } from './signup-capture-states';
import { test, expect } from '@playwright/test';
const state = (page: import('@playwright/test').Page) => page.evaluate(() => {
 const c=(window as unknown as {__cdOnb:{comp:{state:{i:number;data:{idOver:string;shopCount:number}}}}}).__cdOnb.comp;
 return {i:c.state.i,idOver:c.state.data.idOver,shopCount:c.state.data.shopCount};
});
test('Enter activates the focused choice rather than advancing the chapter',async({page})=>{
 await page.goto('/onboarding?step=idline');
 const every=page.getByRole('button',{name:/^Every deal/});await every.focus();await every.press('Enter');
 await expect.poll(()=>state(page)).toMatchObject({i:10,idOver:'0'});
 await page.goto('/onboarding?step=shops-more');
 const plus=page.getByRole('button',{name:'+',exact:true});await plus.focus();const before=await state(page);await plus.press('Enter');
 await expect.poll(()=>state(page)).toMatchObject({i:30,shopCount:Math.max(2,before.shopCount)+1});
});
test('phone inputs, links and controls meet the specified 44px target',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 for(const step of ['shops-more','currencies','count','team','pay']){
   await page.goto('/onboarding?step='+step);await expect(page.locator('[data-product]')).toBeVisible();
   if(step==='pay')await page.getByRole('button',{name:/The agreement/}).click();
   const small=()=>page.locator('[data-product] button,[data-product] a[href],[data-product] input').evaluateAll(es=>es.filter(e=>e.getClientRects().length&&!e.closest('[inert]')).map(e=>({label:e.getAttribute('aria-label')||e.textContent?.trim(),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})).filter(e=>e.w<43.9||e.h<43.9));
   await expect.poll(small,{message:step}).toEqual([]);
 }
});

for(const [size,width,height] of [['desktop',1440,860],['phone',390,844]] as const) {
 for(const [stateName,_rail,step,act] of SIGNUP_STATES) {
  test(`axe ${stateName} ${size}`,async({page},info)=>{
   await page.setViewportSize({width,height});await page.goto('/onboarding?step='+step);
   await page.waitForTimeout(2500); // pack capture timing, including entrance animation
   if(act)await act(actions(page));
   await page.addScriptTag({content:axe.source});
   const result=await page.evaluate(async()=>{
    const a=(window as unknown as {axe:typeof axe}).axe;
    return a.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});
   });
   await info.attach('axe-evidence',{body:JSON.stringify({state:stateName,size,version:result.testEngine.version,violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});
   expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))).toEqual([]);
   const targets=await page.evaluate(()=>{
    const es=[...document.querySelectorAll<HTMLElement>('button,a[href],input,summary,[tabindex]')].filter(e=>e.tabIndex>=0&&!e.matches(':disabled')&&!e.closest('[inert]')&&(!e.closest('details:not([open])')||e.tagName==='SUMMARY')&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
    es.forEach((e,i)=>e.dataset.auditTab=String(i));document.body.tabIndex=-1;document.body.focus();return es.length;
   });
   const visited=new Set<string>();
   for(let i=0;i<targets+3;i++){
    await page.keyboard.press('Tab');
    const focus=await page.evaluate(()=>{const e=document.activeElement as HTMLElement;return {id:e?.dataset.auditTab,visible:!!e?.getClientRects().length,inert:!!e?.closest('[inert]')};});
    if(focus.id!==undefined){expect(focus.visible).toBe(true);expect(focus.inert).toBe(false);visited.add(focus.id);}
   }
   await info.attach('keyboard-evidence',{body:JSON.stringify({state:stateName,size,targets,visited:[...visited]}),contentType:'application/json'});
   expect(visited.size,'Every visible enabled control can be reached with Tab').toBe(targets);
  });
 }
}
