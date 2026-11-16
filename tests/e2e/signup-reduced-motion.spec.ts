import { test, expect } from '@playwright/test';
import { SIGNUP_STATES, actions } from './signup-capture-states';
for(const width of [1440,390])test(`all 38 signup states honor reduced motion at ${width}`,async({page},info)=>{
 test.setTimeout(180000);await page.setViewportSize({width,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 const evidence=[];
 for(const [name,_rail,step,act] of SIGNUP_STATES){
  await page.goto('/onboarding?step='+step);await page.waitForTimeout(500);if(act)await act(actions(page));
  const motion=await page.evaluate(()=>({playing:[...document.querySelectorAll('video')].filter(v=>!v.paused).length,animations:document.getAnimations().filter(a=>a.playState==='running').length}));
  evidence.push({name,...motion});expect(motion,name).toEqual({playing:0,animations:0});
 }
 await info.attach('reduced-motion-38',{body:JSON.stringify(evidence),contentType:'application/json'});
});
