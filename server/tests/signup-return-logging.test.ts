import { afterAll, beforeAll, expect, it } from "vitest";
import { Writable } from "node:stream";
import path from "node:path";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
let handle: DbHandle; let app: Awaited<ReturnType<typeof buildApp>>;
const lines: string[] = [];
beforeAll(async () => {
 process.env.PGLITE_MEMORY = "1";
 process.env.STATIC_DIR = path.resolve(".."); process.env.STATIC_INDEX = "CurrencyDesk OS.html"; process.env.SITE_INDEX = "web/index.html";
 handle = await createDb(); await seed(handle.db);
 app = await buildApp(handle.db, {}, new Writable({write(chunk, _encoding, done) {lines.push(String(chunk));done();}}));
});
afterAll(async () => {await app.close();await handle.close();});
it("provider return queries never reach actual incoming request logs", async () => {
 for (const route of ["/onboarding", "/onboarding/sso", "/onboarding/CD-TEST-2222"]) {
   lines.length = 0;
   const response = await app.inject({method:"GET",url:route+"?setup_intent_client_secret=synthetic-secret&code=synthetic-code&state=synthetic-state",headers:{accept:"text/html"}});
   expect(response.headers["referrer-policy"]).toBe("no-referrer");
   expect(response.headers["cache-control"]).toContain("no-store");
   const requests = lines.flatMap(line => line.trim().split("\n").map(value => JSON.parse(value))).filter(row=>row.req);
   expect(requests).toHaveLength(1);
   expect(requests[0].req.url).not.toContain("?");
   for (const marker of ["synthetic-secret","synthetic-code","synthetic-state"]) expect(lines.join("")).not.toContain(marker);
 }
});

it("an expired enrolment refuses once over real HTTP and leaves the server alive", async () => {
 await handle.db.insert(schema.enquiries).values({id:"enq-return-log",reference:"CD-Z90001",kind:"early_access",email:"owner@synthetic.example",status:"invited",cdId:"CD-TEST-2222"});
 const origin=await app.listen({host:"127.0.0.1",port:0});
 for(let i=0;i<2;i++) {
   const denied=await fetch(origin+"/api/onboarding/CD-TEST-2222/prices");expect(denied.status).toBe(401);expect(await denied.json()).toMatchObject({error:"sign_in_again"});
 }
 expect((await fetch(origin+"/api/onboarding/prices")).status).toBe(200);
});
