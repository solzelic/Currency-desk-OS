import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";
import { z } from "zod";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { resolveWorkspaceForUser } from "../auth/workspace-scope.js";
import { type Db } from "../db/index.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import { isRetryable } from "../ledger/retry.js";
import { ensureLedgerPrincipal } from "../ledger/principal.js";
import { tenantPlan } from "../routes/tenant.js";
import { currencyCode } from "../ledger/currencies.js";
import { QuoteService } from "./service.js";

const money=z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).refine(v=>Number(v)<=1_000_000_000);
const rate=z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/).refine(v=>Number(v)>0&&Number(v)<=1_000_000_000);
/* Shape only — same `currencyCode` as the ledger money routes. Pair and
   desk-set rules stay in QuoteService.create (pairAllowed, assertTradeable). */
const createBody=z.object({customerId:z.string().min(1).max(120),from:currencyCode,to:currencyCode,inputAmount:money,feeCad:money,direction:z.enum(["customer_buy_foreign","customer_sell_foreign","customer_cross"]),supersedesQuoteId:z.string().min(1).max(120).optional()});
const overrideBody=z.object({customerRate:rate,reason:z.string().trim().min(1).max(1000)});
const postBody=z.object({idempotencyKey:z.string().min(1).max(200),purpose:z.string().trim().min(1).max(500),sourceOfFunds:z.string().trim().min(1).max(500),thirdParty:z.boolean().default(false),thirdPartyName:z.string().trim().max(200).optional(),identityNumber:z.string().trim().max(40).optional(),usdLargeNotes:z.boolean().optional(),usdNoteSerials:z.array(z.string().trim().min(1).max(40)).max(200).optional(),reportSuspicion:z.boolean().optional()}).refine(v=>!v.thirdParty||!!v.thirdPartyName,{message:"Third-party name is required.",path:["thirdPartyName"]}).refine(v=>v.thirdParty||!v.thirdPartyName,{message:"Third-party name requires third-party status.",path:["thirdPartyName"]});
type Resolution={kind:"authenticated";actor:LedgerActor}|{kind:"unauthenticated"}|{kind:"scope_denied"}|{kind:"plan_denied"};
/* The hash scripts/build-os.mjs writes next to the desk. A request that
   names a different one is a tab left open across a deploy. A request
   that names none — the tests, and a shell that has no stamp — is
   allowed, because refusing it would reject every quote that is not
   this page. */
let cachedBuildId: string | null | undefined;
function deployedBuildId(): string | null {
  if (cachedBuildId !== undefined) return cachedBuildId;
  const roots = [
    process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : "",
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  ].filter(Boolean);
  for (const root of roots) {
    const file = path.join(root, "web/app/build-id.txt");
    if (!existsSync(file)) continue;
    const id = readFileSync(file, "utf8").trim();
    if (id) return (cachedBuildId = id);
  }
  return (cachedBuildId = null);
}
function screenIsCurrent(req: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  const header = req.headers["x-currencydesk-build"];
  const sent = Array.isArray(header) ? header[0] : header;
  if (sent == null || sent === "") return true;
  if (sent === deployedBuildId()) return true;
  reply.code(409).send({ code: "RELOAD_REQUIRED", message: "This screen is out of date. Reload to continue." });
  return false;
}
export function registerQuoteRoutes(app:FastifyInstance,db:Db,databaseUrl:string){const pool=new pg.Pool({connectionString:databaseUrl}),service=new QuoteService(pool);app.addHook("onClose",async()=>pool.end());
async function actor(req:FastifyRequest):Promise<Resolution>{const user=await resolveSession(db,req.cookies[SESSION_COOKIE]);if(!user)return {kind:"unauthenticated"};if((await tenantPlan(db,user.tenantId))==="basic")return {kind:"plan_denied"};const workspace=await resolveWorkspaceForUser(db,user,req.headers["x-workspace-id"],req.cookies[SESSION_COOKIE]);if(!workspace)return {kind:"scope_denied"};const current={userId:user.id,tenantId:user.tenantId,legalEntityId:user.legalEntityId,branchId:workspace.branchId,workspaceId:workspace.id,tillId:workspace.tillId,role:user.role,authorizedBranchIds:user.authorizedBranchIds};await ensureLedgerPrincipal(pool,current);return {kind:"authenticated",actor:current};}
/* Contention that survived its retries is not a fault: the transaction
     rolled back whole and nothing was written. Answering 500 INTERNAL_ERROR
     is wrong in both halves and sends a teller hunting for a problem with a
     quote that was perfectly good. Same mapping as the ledger routes. */
  function fail(reply:any,error:unknown){if(isRetryable(error)){app.log.warn(error,"quote contention after retries");return reply.code(409).send({code:"LEDGER_BUSY",message:"The desk is recording another change to this till. Nothing was quoted — try again."});}if(!(error instanceof LedgerError)){app.log.error(error,"quote route failure");return reply.code(500).send({code:"INTERNAL_ERROR"});}const status=error.code==="AUTHORIZATION_DENIED"||error.code==="SCOPE_DENIED"?403:error.code==="INVALID_REQUEST"?400:error.code==="IDEMPOTENCY_IN_PROGRESS"?409:422;return reply.code(status).send({code:error.code,message:error.message});}
async function current(req:FastifyRequest,reply:any){const result=await actor(req);if(result.kind==="unauthenticated"){reply.code(401).send({code:"AUTHENTICATION_REQUIRED"});return null;}if(result.kind==="plan_denied"){reply.code(403).send({code:"PLAN_NOT_ENTITLED"});return null;}if(result.kind==="scope_denied"){reply.code(403).send({code:"SCOPE_DENIED"});return null;}return result.actor;}
app.post("/api/quotes",async(req,reply)=>{const body=createBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);if(!a||!screenIsCurrent(req,reply))return;return reply.code(201).send(await service.create(a,body.data));}catch(e){return fail(reply,e);}});
app.get("/api/quotes/:quoteId",async(req,reply)=>{try{const a=await current(req,reply);return a?reply.send(await service.get(a,(req.params as any).quoteId)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/cancel",async(req,reply)=>{try{const a=await current(req,reply);return a?reply.send(await service.cancel(a,(req.params as any).quoteId)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/override",async(req,reply)=>{const body=overrideBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);return a?reply.send(await service.override(a,(req.params as any).quoteId,body.data.customerRate,body.data.reason)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/post",async(req,reply)=>{const body=postBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);if(!a||!screenIsCurrent(req,reply))return;return reply.code(201).send(await service.post(a,(req.params as any).quoteId,body.data.idempotencyKey,body.data.purpose,body.data.sourceOfFunds,body.data.thirdParty,body.data.thirdPartyName,{identityNumber:body.data.identityNumber,usdLargeNotes:body.data.usdLargeNotes,usdNoteSerials:body.data.usdNoteSerials,reportSuspicion:body.data.reportSuspicion}));}catch(e){return fail(reply,e);}});
}
