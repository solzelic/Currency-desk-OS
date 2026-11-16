import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('visual evidence keeps monetary glyphs and every difference, excluding only proven ambient motion',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'signup-capture-'));
 try{
  for(const sub of ['base','built'])mkdirSync(path.join(dir,sub));
  const elements=Array.from({length:14},(_,i)=>({tag:'span',text:i?'amount '+i:'$',x:0,y:i,w:20,h:20}));
  elements.push({tag:'span',text:'€',x:0,y:0,w:20,h:20,decorativeCurrencyDrift:true});
  writeFileSync(path.join(dir,'base','one.desktop.json'),JSON.stringify({elements,pageScrolls:false}));
  writeFileSync(path.join(dir,'built','one.desktop.json'),JSON.stringify({elements:elements.map(e=>({...e,x:4})),pageScrolls:false}));
  execFileSync(process.execPath,['scripts/compare-signup-capture.mjs',path.join(dir,'base'),path.join(dir,'built'),path.join(dir,'result.json')]);
  const r=JSON.parse(readFileSync(path.join(dir,'result.json'))).report[0];
  assert.equal(r.moved,14);assert.equal(r.detail.moved.length,14);assert.equal(r.detail.moved[0].text,'$');assert.equal(r.excludedAmbient.base.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
