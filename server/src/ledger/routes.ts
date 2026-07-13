import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { LedgerError, LedgerService, type LedgerActor } from "./service.js";

const postBody = z.object({ idempotencyKey:z.string().min(1).max(200),customerId:z.string().min(1),from:z.enum(["CAD","USD","EUR","GBP"]),to:z.enum(["CAD","USD","EUR","GBP"]),inputAmount:z.string(),feeCad:z.string(),purpose:z.string(),sourceOfFunds:z.string() });
const reverseBody = z.object({ idempotencyKey:z.string().min(1).max(200),reason:z.string().min(1) });

export function registerLedgerRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl }); const service = new LedgerService(pool);
  app.addHook("onClose", async () => { await pool.end(); });
  async function actor(req: Parameters<typeof resolveSession>[1] extends never ? never : any): Promise<LedgerActor | null> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]); if (!user) return null;
    const workspaceId = typeof req.headers["x-workspace-id"] === "string" ? req.headers["x-workspace-id"] : undefined;
    const workspaces = await db.select().from(schema.workspaces).where(eq(schema.workspaces.branchId,user.branchId));
    const workspace = workspaces.find((item)=>item.id===workspaceId) ?? workspaces[0]; if(!workspace || workspace.tenantId!==user.tenantId || workspace.legalEntityId!==user.legalEntityId) return null;
    return { userId:user.id,tenantId:user.tenantId,legalEntityId:user.legalEntityId,branchId:user.branchId,workspaceId:workspace.id,tillId:workspace.tillId,role:user.role,authorizedBranchIds:user.authorizedBranchIds };
  }
  const fail=(reply:any,error:unknown)=>{const e=error instanceof LedgerError?error:new LedgerError("INTERNAL_ERROR","Unexpected server error.");const status=e.code==="AUTHENTICATION_REQUIRED"?401:e.code==="AUTHORIZATION_DENIED"||e.code==="SCOPE_DENIED"?403:e.code==="IDEMPOTENCY_IN_PROGRESS"?409:422;return reply.code(status).send({code:e.code,message:e.message});};
  app.post("/api/ledger/exchanges",async(req,reply)=>{const parsed=postBody.safeParse(req.body);if(!parsed.success)return reply.code(400).send({code:"INVALID_REQUEST"});const current=await actor(req);if(!current)return reply.code(401).send({code:"AUTHENTICATION_REQUIRED"});try{return reply.code(201).send(await service.post(current,parsed.data));}catch(error){return fail(reply,error);}});
  app.post("/api/ledger/transactions/:transactionId/reversal",async(req,reply)=>{const parsed=reverseBody.safeParse(req.body);if(!parsed.success)return reply.code(400).send({code:"INVALID_REQUEST"});const current=await actor(req);if(!current)return reply.code(401).send({code:"AUTHENTICATION_REQUIRED"});try{return reply.code(201).send(await service.reverse(current,(req.params as {transactionId:string}).transactionId,parsed.data.idempotencyKey,parsed.data.reason));}catch(error){return fail(reply,error);}});
}
