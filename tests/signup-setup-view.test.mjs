import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('unbacked converted draft totals never become a displayed vault balance',()=>{
 const CD={priced:(c,r)=>r};vm.runInNewContext(fs.readFileSync(new URL('../design/onboarding/signup-v2.1-setup.js',import.meta.url),'utf8'),{window:{__cdOnb:CD}});
 const c={state:{i:8,data:{float:{CAD:'100',USD:'200'},count:{}}}};
 const value=CD.priced(c,{showDrawer:true,drawerStr:'$374.00',reviewCards:[{t:'Vault count',main:'≈ $374.00 in the vault',sub:'1 of 2 currencies counted',hasSub:true,onEdit:'retained'}]});
 assert.equal(value.drawerStr,'Not posted');assert.equal(value.reviewCards[0].main,'Count saved by currency');assert.equal(value.reviewCards[0].onEdit,'retained');
 assert.equal(value.reviewCards[0].sub,'1 of 2 currencies counted');assert.equal(value.reviewCards[0].hasSub,true);
 assert.equal(CD.priced(c,{reviewCards:[{t:'Vault count',sub:'',hasSub:false}]}).reviewCards[0].hasSub,false,'no extra line beyond the prototype count note');
 c.state.data.countLater=true;assert.equal(CD.priced(c,{reviewCards:[{t:'Vault count'}]}).reviewCards[0].main,'Count inside');
});
