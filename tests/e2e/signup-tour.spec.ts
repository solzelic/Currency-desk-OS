import {test,expect} from '@playwright/test';
for(const width of [1440,390])test(`reduced-motion tour uses stills, manual navigation and trapped focus at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto('/onboarding?step=welcome');const start=page.getByRole('button',{name:/Watch the tour/});await start.click();
 const dialog=page.getByRole('dialog',{name:'CurrencyDesk tour'}),close=dialog.getByRole('button',{name:/Close/});
 await expect(close).toBeFocused();await expect(page.locator('[data-product]')).toHaveAttribute('inert','');
 await page.keyboard.press('Tab');await expect(dialog.getByRole('region',{name:'Tour description'})).toBeFocused();
 await dialog.getByRole('button',{name:'Next',exact:true}).click();await expect(dialog.locator('img')).toBeVisible();
 expect(await dialog.locator('img').evaluate((e:HTMLImageElement)=>e.complete&&e.naturalWidth===1200)).toBe(true);
 await expect(dialog.locator('video')).toHaveCount(0);await page.waitForTimeout(4500);await expect(dialog.locator('img')).toBeVisible();
 await dialog.getByRole('button',{name:'Next',exact:true}).click();await expect(dialog.getByText('Your ID line:',{exact:false})).toBeVisible();
 await page.screenshot({path:test.info().outputPath('reduced-scene.png')});
 for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await dialog.evaluate(e=>e.contains(document.activeElement))).toBe(true);}
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(start).toBeFocused();
 expect(await page.locator('video').evaluateAll(es=>es.every(e=>e.paused))).toBe(true);
 expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length)).toBe(0);
});
test('motion tour plays a real app recording and responds to a changed motion preference',async({page})=>{
 await page.goto('/onboarding?step=welcome');await page.getByRole('button',{name:/Watch the tour/}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Next',exact:true}).click();
 const video=dialog.locator('video');await expect(video).toHaveAttribute('src',/\/recordings\/home.webm$/);
 await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0);
 await expect(dialog.getByText(/Recorded in a synthetic desk/)).toBeVisible();
 await page.emulateMedia({reducedMotion:'reduce'});await expect(dialog.locator('img')).toBeVisible();await expect(video).toHaveCount(0);
 await page.screenshot({path:test.info().outputPath('recorded-home-still.png')});
});

test('playing tour honors reduced motion while its change notification is delayed',async({page})=>{
 // Keep the browser's real media-query state; delay only delivery to the app.
 await page.addInitScript(()=>{
  const matchMedia=window.matchMedia.bind(window);
  const pending:Array<()=>void>=[];
  (window as any).releaseMotionNotifications=()=>pending.splice(0).forEach(deliver=>deliver());
  window.matchMedia=query=>{
   const media=matchMedia(query),add=media.addEventListener.bind(media);
   if(query==='(prefers-reduced-motion: reduce)')media.addEventListener=(type,listener,options)=>{
    if(type!=='change'||!listener)return add(type,listener,options);
    add(type,event=>pending.push(()=>typeof listener==='function'?listener.call(media,event):listener.handleEvent(event)),options);
   };
   return media;
  };
 });
 await page.goto('/onboarding?step=welcome');await page.getByRole('button',{name:/Watch the tour/}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Next',exact:true}).click();
 const video=dialog.locator('video');await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0);
 const playing=await video.elementHandle();
 await page.emulateMedia({reducedMotion:'reduce'});
 expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
 await expect(dialog.locator('img')).toBeVisible();await expect(video).toHaveCount(0);
 expect(await playing!.evaluate((v:HTMLVideoElement)=>v.paused)).toBe(true);
 await page.evaluate(()=>(window as any).releaseMotionNotifications());
 await expect(dialog.locator('img')).toBeVisible();await expect(video).toHaveCount(0);
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
