import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import type { AuthenticatedLedgerActor, LedgerCurrency, ReceiptReadyTransaction } from "../ledger/contracts";
import type { LedgerPostingStore, LockedPostingContext, PersistPost, PersistReversal, PersistedTransaction } from "../ledger/service";
import { fixed } from "../ledger/money";
import { LedgerApiError } from "../ledger/errors";

type Db = Pick<PoolClient, "query">;
const scopeValues = (scope: AuthenticatedLedgerActor) => [scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId];

export class PostgresLedgerStore implements LedgerPostingStore {
  private client: PoolClient | null = null;
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (store: LedgerPostingStore) => Promise<T>): Promise<T> {
    if (this.client) return work(this);
    const client = await this.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"); this.client = client; const result = await work(this); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { this.client = null; client.release(); }
  }
  private db(): Db { if (!this.client) throw new Error("PostgreSQL operations require a transaction."); return this.client; }

  async getIdempotent(scope: AuthenticatedLedgerActor, key: string): Promise<ReceiptReadyTransaction | null | "processing"> {
    const row = await this.db().query("SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND idempotency_key=$6 FOR UPDATE", [...scopeValues(scope), scope.tillId, key]);
    if (!row.rowCount) return null;
    return row.rows[0].response ?? "processing";
  }
  async claimIdempotency(scope: AuthenticatedLedgerActor, key: string): Promise<boolean> {
    const result = await this.db().query("INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [...scopeValues(scope), scope.tillId, key]);
    return result.rowCount === 1;
  }
  async lockPostingContext(scope: AuthenticatedLedgerActor, customerId: string): Promise<LockedPostingContext | null> {
    const db = this.db(); const scopeParams = scopeValues(scope);
    const user = await db.query("SELECT user_id, role, authorized_branch_ids FROM ledger_users WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND user_id=$5 FOR UPDATE", [...scopeParams, scope.userId]);
    const customer = await db.query("SELECT customer_id AS id,name,risk,id_status FROM ledger_customers WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND customer_id=$5 FOR UPDATE", [...scopeParams, customerId]);
    if (!user.rowCount || !customer.rowCount) return null;
    const tills = await db.query("SELECT currency,available_amount FROM ledger_tills WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 FOR UPDATE", [...scopeParams, scope.tillId]);
    const rates = await db.query("SELECT currency,units_per_cad FROM ledger_rates WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND active=true", scopeParams);
    const seq = await db.query("SELECT count(*)::int AS count FROM posted_transactions WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4", scopeParams);
    const till = Object.fromEntries(tills.rows.map((row) => [row.currency, new Decimal(row.available_amount)])) as Record<LedgerCurrency, Decimal>;
    const unitsPerCad = Object.fromEntries(rates.rows.map((row) => [row.currency, new Decimal(row.units_per_cad)])) as Record<LedgerCurrency, Decimal>;
    if (!(unitsPerCad.CAD && unitsPerCad.USD && unitsPerCad.EUR && unitsPerCad.GBP)) return null;
    return { actor: { ...scope, id: user.rows[0].user_id, name: user.rows[0].user_id, role: user.rows[0].role, authorizedBranchIds: user.rows[0].authorized_branch_ids }, customer: { id: customer.rows[0].id, name: customer.rows[0].name, risk: customer.rows[0].risk, idStatus: customer.rows[0].id_status }, till, unitsPerCad, nextSequence: seq.rows[0].count + 1 };
  }
  async persistPost(input: PersistPost): Promise<void> {
    const db = this.db(); const s = input.actor; const r = input.response; const now = r.postedAt;
    await db.query("INSERT INTO posted_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,teller_id,status,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)", [r.transactionId,r.transactionRef,...scopeValues(s),s.tillId,r.customerId,s.userId,r.from,r.to,r.inputAmount,r.outputAmount,r.rate,r.feeCad,r.spreadCad,input.request.purpose,input.request.sourceOfFunds,now]);
    for (const movement of input.tillMovements) { const delta = movement.direction === "in" ? movement.amount : movement.amount.neg(); await db.query("UPDATE ledger_tills SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1 >= 0", [fixed(delta),...scopeValues(s),s.tillId,movement.currency]); await db.query("INSERT INTO till_movements (transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,direction,amount,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [r.transactionId,...scopeValues(s),s.tillId,movement.currency,movement.direction,fixed(movement.amount),now]); }
    for (const line of input.journal) await db.query("INSERT INTO journal_entries (transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,account_code,side,amount_cad,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [r.transactionId,...scopeValues(s),line.account,line.side,fixed(line.amountCad),now]);
    await db.query("INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,actor_role,action,target_type,target_id,reason,correlation_id,created_at,new_state) VALUES ($1,$2,$3,$4,$5,$6,$7,'transaction.post','transaction',$8,$9,$10,$11,$12)", [`audit_${r.transactionId}`,...scopeValues(s),s.userId,s.role,r.transactionId,"Authoritative exchange posted.",input.request.idempotencyKey,now,JSON.stringify({ transactionId: r.transactionId })]);
    await db.query("UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND idempotency_key=$7", [JSON.stringify(r),...scopeValues(s),s.tillId,input.request.idempotencyKey]);
  }
  async lockReversibleTransaction(scope: AuthenticatedLedgerActor, transactionId: string): Promise<PersistedTransaction | null> {
    const db=this.db(); const row=await db.query("SELECT * FROM posted_transactions WHERE transaction_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE", [transactionId,...scopeValues(scope),scope.tillId]);
    if (!row.rowCount) return null;
    const existingReversal = await db.query("SELECT reversal_id FROM transaction_reversals WHERE original_transaction_id=$1 FOR UPDATE", [transactionId]);
    if (existingReversal.rowCount) throw new LedgerApiError("REVERSAL_ALREADY_EXISTS", "The transaction already has a reversal.");
    const moves=await db.query("SELECT currency,direction,amount FROM till_movements WHERE transaction_id=$1 FOR UPDATE",[transactionId]); const x=row.rows[0];
    const user=await db.query("SELECT user_id,role,authorized_branch_ids FROM ledger_users WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND user_id=$5 FOR UPDATE",[...scopeValues(scope),scope.userId]);
    if(!user.rowCount) return null;
    return { transactionId:x.transaction_id,transactionRef:x.transaction_ref,postedAt:x.posted_at.toISOString(),status:x.status,customerId:x.customer_id,from:x.from_currency,to:x.to_currency,inputAmount:x.input_amount,outputAmount:x.output_amount,rate:x.rate,feeCad:x.fee_cad,spreadCad:x.spread_cad,receipt:{receiptId:`rcpt_${x.transaction_id}`,lines:[]},registeredActor:{...scope,id:user.rows[0].user_id,name:user.rows[0].user_id,role:user.rows[0].role,authorizedBranchIds:user.rows[0].authorized_branch_ids},originalTillMovements:moves.rows.map((m)=>({currency:m.currency,direction:m.direction,amount:new Decimal(m.amount)})) };
  }
  async persistReversal(input: PersistReversal): Promise<ReceiptReadyTransaction> {
    const db=this.db(), s=input.actor, original=input.original;
    for(const movement of original.originalTillMovements){ const inverse=movement.direction==="in"?"out":"in"; const delta=inverse==="in"?movement.amount:movement.amount.neg(); await db.query("UPDATE ledger_tills SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1 >= 0",[fixed(delta),...scopeValues(s),s.tillId,movement.currency]); await db.query("INSERT INTO till_movements (transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,direction,amount,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[original.transactionId,...scopeValues(s),s.tillId,movement.currency,inverse,fixed(movement.amount),input.postedAt]); }
    await db.query("INSERT INTO transaction_reversals (reversal_id,original_transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,actor_id,reason,posted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[input.reversalId,original.transactionId,...scopeValues(s),s.tillId,s.userId,input.request.reason,input.postedAt]);
    await db.query("INSERT INTO reversal_journal_entries (reversal_id,original_transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,account_code,side,amount_cad,created_at) SELECT $1,transaction_id,tenant_id,legal_entity_id,branch_id,workspace_id,account_code,CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END,amount_cad,$2 FROM journal_entries WHERE transaction_id=$3", [input.reversalId,input.postedAt,original.transactionId]);
    await db.query("INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,actor_role,action,target_type,target_id,reason,correlation_id,created_at,previous_state,new_state) VALUES ($1,$2,$3,$4,$5,$6,$7,'transaction.reverse','transaction',$8,$9,$10,$11,$12,$13)", [`audit_${input.reversalId}`,...scopeValues(s),s.userId,s.role,original.transactionId,input.request.reason,input.request.idempotencyKey,input.postedAt,JSON.stringify({ transactionId: original.transactionId }),JSON.stringify({ reversalId: input.reversalId })]);
    const response = {...original,status:"reversed" as const,receipt:{receiptId:original.receipt.receiptId,lines:original.receipt.lines}};
    await db.query("UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND idempotency_key=$7", [JSON.stringify(response),...scopeValues(s),s.tillId,input.request.idempotencyKey]);
    return response;
  }
}
