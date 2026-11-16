import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup() {
 const listeners=new Map(), intervals=new Map(), effects=[];
 const media={matches:false,addEventListener:(t,f)=>listeners.set('media:'+t,f),removeEventListener:(t,f)=>{assert.equal(listeners.get('media:'+t),f);listeners.delete('media:'+t);}};
 const CD={mount(){},priced:(c,r)=>r,h:{call:()=>Promise.resolve({status:503})}};
 const c={state:{tour:{k:0,seq:'tour'},data:{}},TOUR:[{kind:'clip',caps:[]}],SEQS:{},
  _tourVals:()=>({tourIsClip:true}),_tourTick(){effects.push('advance');},_playVids(){effects.push('play');},
  forceUpdate(){effects.push(this._tourVals().tourStillClip?'still':'video');},
  componentWillUnmount(){clear(this._tourI);effects.push('unmount');}};
 function clear(id){intervals.delete(id);}
 const document={querySelectorAll:()=>[{pause(){effects.push('pause');}}],
  addEventListener:(t,f,capture)=>{assert.equal(capture,true);listeners.set(t,f);},
  removeEventListener:(t,f,capture)=>{assert.equal(capture,true);assert.equal(listeners.get(t),f);listeners.delete(t);}};
 vm.runInNewContext(fs.readFileSync(new URL('../design/onboarding/signup-v2.1-tour.js',import.meta.url),'utf8'),{
  window:{__cdOnb:CD,matchMedia:()=>media},document,clearInterval:clear,
  setInterval:f=>{const id=Symbol();intervals.set(id,f);return id;}});
 CD.mount(c);
 return {c,media,effects,intervals,listeners,playback(owned=true){listeners.get('timeupdate')?.({target:{matches:()=>owned}});}};
}
test('playback reconciles a delayed motion change once, pausing before painting the still',()=>{
 const h=setup();h.playback();assert.deepEqual(h.effects,[]);
 h.media.matches=true;h.playback(false);assert.deepEqual(h.effects,[]);
 h.playback();assert.deepEqual(h.effects,['pause','still']);assert.equal(h.intervals.size,0);
 h.playback();assert.deepEqual(h.effects,['pause','still']);
 // The eventual notification must keep the still and must not resume animation.
 h.listeners.get('media:change')();assert.deepEqual(h.effects,['pause','still','pause','still']);assert.equal(h.intervals.size,0);
});
test('normal motion changes retain playback and dispose all listeners and tour timers',()=>{
 const h=setup();h.media.matches=true;h.listeners.get('media:change')();
 h.media.matches=false;h.listeners.get('media:change')();
 assert.deepEqual(h.effects,['pause','still','play','video']);assert.equal(h.intervals.size,1);
 h.c.componentWillUnmount();assert.equal(h.listeners.size,0);assert.equal(h.intervals.size,0);
});
