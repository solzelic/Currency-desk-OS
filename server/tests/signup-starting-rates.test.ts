import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, schema, type DbHandle } from '../src/db/index.js';
import { provisionDesk } from '../src/onboarding/provision.js';
let handle:DbHandle;
beforeAll(async()=>{process.env.PGLITE_MEMORY='1';handle=await createDb();});
afterAll(async()=>{await handle.close();});
async function open(homeCurrency='CAD', currencies=['USD','GBP'], requireMarketRates=true){
 const slug='market-'+randomUUID().slice(0,8);
 const made=await provisionDesk(handle.db,{businessName:'Synthetic rates',legalName:'Synthetic rates',ownerName:'Synthetic Owner',email:slug+'@example.test',slug,plan:'full',setup:{country:homeCurrency==='CAD'?'CA':'XX',homeCurrency,currencies},msbNumber:null,regulator:'FINTRAC',team:[]},'test-hash','test',{requireNewTenant:true,requireMarketRates});
 return handle.db.select().from(schema.rateBoards).where(eq(schema.rateBoards.tenantId,made.tenantId));
}
it('strict provisioning omits missing/invalid currencies and pins its snapshot',async()=>{
 await handle.db.insert(schema.marketRates).values({id:'synthetic-snapshot',provider:'synthetic',mids:{USD:1.25,GBP:-2,EUR:1.5}});
 const [board]=await open();expect(board?.boardRows).toEqual({USD:{mid:1.25,show:true}});expect(board?.marketSnapshotId).toBe('synthetic-snapshot');
 const [foreign]=await open('EUR',['USD','GBP']);expect(foreign?.boardRows).toEqual({USD:{mid:0.833333333333,show:true}});
 expect(await open('JPY',['USD'])).toEqual([]);
 expect(await open('CAD',[])).toEqual([]);
});
it('the legacy provisioning contract keeps its indicative fallback',async()=>{
 const [board]=await open('CAD',['JPY'],false);expect(board?.boardRows?.JPY?.mid).toBeGreaterThan(0);
});
