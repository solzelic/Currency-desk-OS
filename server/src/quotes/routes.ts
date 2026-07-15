import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import { QuoteService } from "./service.js";

const money=z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).refine(v=>Number(v)<=1_000_000_000);
const rate=z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/).refine(v=>Number(v)>0&&Number(v)<=1_000_000_000);
const createBody=z.object({customerId:z.string().min(1).max(120),from:z.enum(["CAD","USD","EUR","GBP"]),to:z.enum(["CAD","USD","EUR","GBP"]),inputAmount:money,feeCad:money,direction:z.enum(["customer_buy_foreign","customer_sell_foreign"]),supersedesQuoteId:z.string().min(1).max(120).optional()});
const overrideBody=z.object({customerRate:rate,reason:z.string().trim().min(1).max(1000)});
const postBody=z.object({idempotencyKey:z.string().min(1).max(200),purpose:z.string().trim().min(1).max(500),sourceOfFunds:z.string().trim().min(1).max(500)});
type Resolution={kind:"authenticated";actor:LedgerActor}|{kind:"unauthenticated"}|{kind:"scope_denied"};
export function registerQuoteRoutes(app:FastifyInstance,db:Db,databaseUrl:string){const pool=new pg.Pool({connectionString:databaseUrl}),service=new QuoteService(pool);app.addHook("onClose",async()=>pool.end());
async function actor(req:FastifyRequest):Promise<Resolution>{const user=await resolveSession(db,req.cookies[SESSION_COOKIE]);if(!user)return {kind:"unauthenticated"};const header=req.headers["x-workspace-id"];if(Array.isArray(header))return {kind:"scope_denied"};const candidates=await db.select().from(schema.workspaces).where(and(eq(schema.workspaces.tenantId,user.tenantId),eq(schema.workspaces.legalEntityId,user.legalEntityId),eq(schema.workspaces.branchId,user.branchId)));const workspace=header?candidates.find(w=>w.id===header):candidates.length===1?candidates[0]:undefined;if(!workspace||!user.authorizedBranchIds.includes(workspace.branchId))return {kind:"scope_denied"};return {kind:"authenticated",actor:{userId:user.id,tenantId:user.tenantId,legalEntityId:user.legalEntityId,branchId:workspace.branchId,workspaceId:workspace.id,tillId:workspace.tillId,role:user.role,authorizedBranchIds:user.authorizedBranchIds}};}
function fail(reply:any,error:unknown){if(!(error instanceof LedgerError)){app.log.error(error,"quote route failure");return reply.code(500).send({code:"INTERNAL_ERROR"});}const status=error.code==="AUTHORIZATION_DENIED"||error.code==="SCOPE_DENIED"?403:error.code==="INVALID_REQUEST"?400:error.code==="IDEMPOTENCY_IN_PROGRESS"?409:422;return reply.code(status).send({code:error.code,message:error.message});}
async function current(req:FastifyRequest,reply:any){const result=await actor(req);if(result.kind==="unauthenticated"){reply.code(401).send({code:"AUTHENTICATION_REQUIRED"});return null;}if(result.kind==="scope_denied"){reply.code(403).send({code:"SCOPE_DENIED"});return null;}return result.actor;}
app.post("/api/quotes",async(req,reply)=>{const body=createBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);return a?reply.code(201).send(await service.create(a,body.data)):undefined;}catch(e){return fail(reply,e);}});
app.get("/api/quotes/:quoteId",async(req,reply)=>{try{const a=await current(req,reply);return a?reply.send(await service.get(a,(req.params as any).quoteId)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/cancel",async(req,reply)=>{try{const a=await current(req,reply);return a?reply.send(await service.cancel(a,(req.params as any).quoteId)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/override",async(req,reply)=>{const body=overrideBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);return a?reply.send(await service.override(a,(req.params as any).quoteId,body.data.customerRate,body.data.reason)):undefined;}catch(e){return fail(reply,e);}});
app.post("/api/quotes/:quoteId/post",async(req,reply)=>{const body=postBody.safeParse(req.body);if(!body.success)return reply.code(400).send({code:"INVALID_REQUEST"});try{const a=await current(req,reply);return a?reply.code(201).send(await service.post(a,(req.params as any).quoteId,body.data.idempotencyKey,body.data.purpose,body.data.sourceOfFunds)):undefined;}catch(e){return fail(reply,e);}});
}
