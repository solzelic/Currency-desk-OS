import { randomUUID } from "node:crypto";
import type pg from "pg";
import { LedgerError, type LedgerActor } from "./service.js";
import { authorizeLedgerActor } from "./principal.js";

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

export type CustomerInput = {
  externalRef?: string;
  name: string;
  risk: "normal" | "enhanced" | "high";
  idStatus: "verified" | "pending" | "missing" | "expired";
};

export class LedgerProvisioningService {
  constructor(private readonly pool: pg.Pool) {}

  async listCustomers(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "customer:view");
      const result = await client.query(
        `SELECT customer_id,external_ref,name,risk,id_status,created_at,updated_at
           FROM ledger_customers
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4
          ORDER BY name,customer_id`,
        scope(actor).slice(0, 4),
      );
      await client.query("COMMIT");
      return result.rows.map(customerJson);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveCustomer(
    actor: LedgerActor,
    input: CustomerInput,
    customerId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "customer:write");
      const now = new Date();
      let result: pg.QueryResult;
      if (customerId) {
        result = await client.query(
          `UPDATE ledger_customers
              SET external_ref=$1,name=$2,risk=$3,id_status=$4,updated_by=$5,updated_at=$6
            WHERE customer_id=$7 AND tenant_id=$8 AND legal_entity_id=$9
              AND branch_id=$10 AND workspace_id=$11
          RETURNING customer_id,external_ref,name,risk,id_status,created_at,updated_at`,
          [
            input.externalRef ?? null,
            input.name,
            input.risk,
            input.idStatus,
            actor.userId,
            now,
            customerId,
            ...scope(actor).slice(0, 4),
          ],
        );
        if (!result.rowCount) {
          throw new LedgerError(
            "CUSTOMER_NOT_FOUND",
            "Customer is not in the active workspace.",
          );
        }
      } else if (input.externalRef) {
        result = await client.query(
          `INSERT INTO ledger_customers
            (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             external_ref,name,risk,id_status,created_by,updated_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$11)
           ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,external_ref)
             WHERE external_ref IS NOT NULL
           DO UPDATE SET name=EXCLUDED.name,risk=EXCLUDED.risk,
                         id_status=EXCLUDED.id_status,updated_by=EXCLUDED.updated_by,
                         updated_at=EXCLUDED.updated_at
           RETURNING customer_id,external_ref,name,risk,id_status,created_at,updated_at`,
          [
            `cust_${randomUUID()}`,
            ...scope(actor).slice(0, 4),
            input.externalRef,
            input.name,
            input.risk,
            input.idStatus,
            actor.userId,
            now,
          ],
        );
      } else {
        result = await client.query(
          `INSERT INTO ledger_customers
            (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             name,risk,id_status,created_by,updated_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$10)
           RETURNING customer_id,external_ref,name,risk,id_status,created_at,updated_at`,
          [
            `cust_${randomUUID()}`,
            ...scope(actor).slice(0, 4),
            input.name,
            input.risk,
            input.idStatus,
            actor.userId,
            now,
          ],
        );
      }
      const row = result.rows[0]!;
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          customerId ? "customer.update" : "customer.create",
          row.customer_id,
          `risk=${input.risk}; id_status=${input.idStatus}`,
          randomUUID(),
          now,
        ],
      );
      await client.query("COMMIT");
      return customerJson(row);
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new LedgerError(
          "CUSTOMER_EXTERNAL_REF_CONFLICT",
          "That customer reference is already assigned in this workspace.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async initializeBalances(
    actor: LedgerActor,
    balances: Partial<Record<"CAD" | "USD" | "EUR" | "GBP", string>>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "till:initialize");
      const activity = await client.query(
        `SELECT EXISTS(
           SELECT 1 FROM ledger_transactions
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5
         ) AS has_transactions,
         EXISTS(
           SELECT 1 FROM ledger_till_balances
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5
         ) AS has_balances`,
        scope(actor),
      );
      if (activity.rows[0].has_transactions) {
        throw new LedgerError(
          "TILL_ALREADY_ACTIVE",
          "Opening balances cannot change after ledger activity.",
        );
      }
      if (activity.rows[0].has_balances) {
        throw new LedgerError(
          "OPENING_BALANCES_ALREADY_SET",
          "Opening balances are already set for this till.",
        );
      }
      const now = new Date();
      for (const [currency, amount] of Object.entries(balances)) {
        await client.query(
          `INSERT INTO ledger_till_balances
            (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [...scope(actor), currency, amount],
        );
      }
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'till.opening_balances',$7,$8,$9,$10)`,
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          actor.tillId,
          JSON.stringify(balances),
          randomUUID(),
          now,
        ],
      );
      await client.query("COMMIT");
      return this.getBalances(actor);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getBalances(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const result = await client.query(
        `SELECT currency,available_amount
           FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
          ORDER BY currency`,
        scope(actor),
      );
      await client.query("COMMIT");
      return {
        tillId: actor.tillId,
        balances: Object.fromEntries(
          result.rows.map((row) => [row.currency.trim(), row.available_amount]),
        ),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTransactions(actor: LedgerActor, limit: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const result = await client.query(
        `SELECT t.*,r.reversal_id,r.reason AS reversal_reason,r.posted_at AS reversed_at
           FROM ledger_transactions t
           LEFT JOIN ledger_reversals r ON r.transaction_id=t.transaction_id
          WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
            AND t.workspace_id=$4 AND t.till_id=$5
          ORDER BY t.posted_at DESC,t.transaction_id DESC
          LIMIT $6`,
        [...scope(actor), limit],
      );
      await client.query("COMMIT");
      return {
        transactions: result.rows.map((row) => ({
          transactionId: row.transaction_id,
          transactionRef: row.transaction_ref,
          quoteId: row.quote_id ?? null,
          customerId: row.customer_id,
          actorId: row.actor_id,
          from: row.from_currency.trim(),
          to: row.to_currency.trim(),
          inputAmount: row.input_amount,
          outputAmount: row.output_amount,
          rate: row.rate,
          marketMid: row.market_mid ?? null,
          feeCad: row.fee_cad,
          spreadCad: row.spread_cad,
          purpose: row.purpose,
          sourceOfFunds: row.source_of_funds,
          thirdParty: row.third_party ?? false,
          thirdPartyName: row.third_party_name ?? null,
          complianceCapturedBy: row.compliance_captured_by ?? row.actor_id,
          complianceCapturedAt: new Date(
            row.compliance_captured_at ?? row.posted_at,
          ).toISOString(),
          rateBoardPublicationId: row.rate_board_publication_id ?? null,
          marketSnapshotId: row.market_snapshot_id ?? null,
          rateSourceType: row.rate_source_type ?? null,
          quoteOverrideId: row.quote_override_id ?? null,
          postedAt: new Date(row.posted_at).toISOString(),
          reversal: row.reversal_id
            ? {
                reversalId: row.reversal_id,
                reason: row.reversal_reason,
                postedAt: new Date(row.reversed_at).toISOString(),
              }
            : null,
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transactionReceipt(actor: LedgerActor, transactionId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const result = await client.query(
        `SELECT t.*,c.name AS customer_name
           FROM ledger_transactions t
           JOIN ledger_customers c ON c.customer_id=t.customer_id
          WHERE t.transaction_id=$1 AND t.tenant_id=$2
            AND t.legal_entity_id=$3 AND t.branch_id=$4
            AND t.workspace_id=$5 AND t.till_id=$6`,
        [transactionId, ...scope(actor)],
      );
      if (!result.rowCount) {
        throw new LedgerError(
          "TRANSACTION_NOT_FOUND",
          "Transaction not found.",
        );
      }
      const row = result.rows[0];
      await client.query("COMMIT");
      return {
        receiptId: `rcpt_${row.transaction_id}`,
        transactionId: row.transaction_id,
        transactionRef: row.transaction_ref,
        postedAt: new Date(row.posted_at).toISOString(),
        lines: [
          "CurrencyDesk OS",
          `Receipt ${row.transaction_ref}`,
          `Customer: ${row.customer_name}`,
          ...(row.quote_id ? [`Quote: ${row.quote_id}`] : []),
          `Paid exchange: ${row.input_amount} ${row.from_currency.trim()}`,
          `Fee paid separately: CAD ${row.fee_cad}`,
          `Received: ${row.output_amount} ${row.to_currency.trim()}`,
        ],
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readiness(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const result = await client.query(
        `SELECT
          (SELECT count(*)::int FROM ledger_customers
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4) AS customer_count,
          (SELECT count(*)::int FROM ledger_till_balances
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5) AS balance_count,
          (SELECT count(*)::int FROM ledger_transactions
            WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
              AND workspace_id=$4 AND till_id=$5) AS transaction_count`,
        scope(actor),
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return {
        ready: row.customer_count > 0 && row.balance_count > 0,
        principal: true,
        customerCount: row.customer_count,
        balanceCount: row.balance_count,
        transactionCount: row.transaction_count,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function customerJson(row: Record<string, unknown>) {
  return {
    customerId: row.customer_id,
    externalRef: row.external_ref ?? null,
    name: row.name,
    risk: row.risk,
    idStatus: row.id_status,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
