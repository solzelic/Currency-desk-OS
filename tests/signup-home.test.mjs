import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../os-src/cdos-signup-home.js',import.meta.url),'utf8');
function setup({embedded=true,query='?onboarding=welcome',tenant={id:'own',setup:{signup:{version:'2.1'}}},ok=true}={}){
 let reads=0;const win={CDOS:{}};win.parent=embedded?{}:win;
 vm.runInNewContext(source,{window:win,location:{search:query},URLSearchParams,fetch:async()=>{reads++;return {ok,json:async()=>({tenant})};}});
 return {load:win.CDOS.signupHomeFromSession,reads:()=>reads};
}
test('welcome needs the embedded entry, authenticated administrator and matching signup tenant',async()=>{
 for(const options of [{embedded:false},{query:''}]){const x=setup(options);assert.equal(await x.load({role:'administrator',tenantId:'own'}),null);assert.equal(x.reads(),0);}
 const staff=setup();assert.equal(await staff.load({role:'teller',tenantId:'own'}),null);assert.equal(staff.reads(),0);
 for(const options of [{tenant:{id:'other',setup:{signup:{version:'2.1'}}}},{tenant:{id:'own',setup:{}}},{ok:false}])assert.equal(await setup(options).load({role:'administrator',tenantId:'own'}),null);
 const x=setup();assert.equal((await x.load({role:'administrator',tenantId:'own'})).id,'own');assert.equal(x.reads(),1);
});
