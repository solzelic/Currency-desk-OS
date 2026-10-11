import { randomUUID } from "node:crypto";
import type pg from "pg";
import { LedgerError, type LedgerActor } from "./service.js";
import { redactDeskEarnings } from "./earnings-redaction.js";
import { authorizeLedgerActor } from "./principal.js";
import { withSerializationRetry } from "./retry.js";
import { SETTLEMENT_DEAL_KINDS_SQL } from "./cheques.js";
import { branchBusinessDate } from "./canada-rules.js";
import {
  derivedIdStatus,
  derivedIdStatusSql,
  displayedDocuments,
  toIdStanding,
  type DisplayedDocument,
  type IdStanding,
} from "./id-on-file.js";

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
  /* The desk's client file. The till used to sync a ledger row under
     `os:<slug>` with no client id, so the documents on the file were
     invisible to the gate and an identified customer could not post. */
  clientId?: string;
};

export class LedgerProvisioningService {
  constructor(private readonly pool: pg.Pool) {}

  async listCustomers(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "customer:view");
      const businessDate = await branchBusinessDate(client, actor.branchId);
      const result = await client.query(
        `SELECT customer_id,external_ref,name,risk,client_id,
                ${derivedIdStatusSql("ledger_customers", "$5")} AS id_status,
                created_at,updated_at
           FROM ledger_customers
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4
          ORDER BY name,customer_id`,
        [...scope(actor).slice(0, 4), businessDate],
      );
      const shown = await displayedDocuments(
        client,
        result.rows.map((row) => row.client_id).filter((id): id is string => !!id),
      );
      await client.query("COMMIT");
      return result.rows.map((row) =>
        customerJson(row, shown.get(row.client_id as string) ?? null),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  saveCustomer(actor: LedgerActor, input: CustomerInput, customerId?: string) {
    return withSerializationRetry(() =>
      this.saveCustomerOnce(actor, input, customerId));
  }

  private async saveCustomerOnce(
    actor: LedgerActor,
    input: CustomerInput,
    customerId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "customer:write");
      const now = new Date();
      if (input.clientId) await assertClientInEntity(client, actor, input.clientId);
      let result: pg.QueryResult;
      /* A client file that already has a counter row in this workspace
         is that row. Returning it is what lets the till post against
         the customer whose documents the gate can see, instead of
         opening a second row under os:<slug> with no client id. */
      const linkedId = !customerId && input.clientId
        ? await linkedCustomerId(client, actor, input.clientId)
        : null;
      if (customerId) {
        /* Name and risk only, plus a client id when this row does not
           have one yet. The stored id_status column is left as it was. */
        result = await client.query(
          `UPDATE ledger_customers
              SET external_ref=$1,name=$2,risk=$3,updated_by=$4,updated_at=$5,
                  client_id=CASE
                    WHEN $6::text IS NULL THEN client_id
                    WHEN client_id IS NULL THEN $6
                    ELSE client_id
                  END
            WHERE customer_id=$7 AND tenant_id=$8 AND legal_entity_id=$9
              AND branch_id=$10 AND workspace_id=$11
          RETURNING customer_id,external_ref,name,risk,id_status,client_id,created_at,updated_at`,
          [
            input.externalRef ?? null,
            input.name,
            input.risk,
            actor.userId,
            now,
            input.clientId ?? null,
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
      } else if (linkedId) {
        result = await client.query(
          `UPDATE ledger_customers
              SET name=$1,risk=$2,updated_by=$3,updated_at=$4
            WHERE customer_id=$5 AND tenant_id=$6 AND legal_entity_id=$7
              AND branch_id=$8 AND workspace_id=$9
          RETURNING customer_id,external_ref,name,risk,id_status,client_id,created_at,updated_at`,
          [input.name, input.risk, actor.userId, now, linkedId, ...scope(actor).slice(0, 4)],
        );
      } else if (input.externalRef) {
        result = await client.query(
          `INSERT INTO ledger_customers
            (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             external_ref,name,risk,id_status,client_id,created_by,updated_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'missing',$9,$10,$10,$11,$11)
           ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,external_ref)
             WHERE external_ref IS NOT NULL
           DO UPDATE SET name=EXCLUDED.name,risk=EXCLUDED.risk,
                         client_id=CASE
                           WHEN ledger_customers.client_id IS NULL THEN EXCLUDED.client_id
                           ELSE ledger_customers.client_id
                         END,
                         updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at
           RETURNING customer_id,external_ref,name,risk,id_status,client_id,created_at,updated_at`,
          [
            `cust_${randomUUID()}`,
            ...scope(actor).slice(0, 4),
            input.externalRef,
            input.name,
            input.risk,
            input.clientId ?? null,
            actor.userId,
            now,
          ],
        );
      } else {
        /* A new counter row has no client and no document. `missing` is
           the only standing that follows from that. It is not a default
           the caller chose. */
        result = await client.query(
          `INSERT INTO ledger_customers
            (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,
             name,risk,id_status,client_id,created_by,updated_by,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'missing',$8,$9,$9,$10,$10)
           RETURNING customer_id,external_ref,name,risk,id_status,client_id,created_at,updated_at`,
          [
            `cust_${randomUUID()}`,
            ...scope(actor).slice(0, 4),
            input.name,
            input.risk,
            input.clientId ?? null,
            actor.userId,
            now,
          ],
        );
      }
      const row = result.rows[0]!;
      if (input.clientId && row.client_id && row.client_id !== input.clientId) {
        throw new LedgerError(
          "CUSTOMER_CLIENT_CONFLICT",
          "That till reference is already linked to a different client.",
        );
      }
      const idStatus = await derivedIdStatus(
        client,
        row.customer_id as string,
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
      );
      const shown = row.client_id
        ? (await displayedDocuments(client, [row.client_id as string])).get(row.client_id as string) ?? null
        : null;
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
          `risk=${input.risk}; id_status=${idStatus} (derived from documents, not the request)`,
          randomUUID(),
          now,
        ],
      );
      await client.query("COMMIT");
      return customerJson({ ...row, id_status: idStatus }, shown);
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

  initializeBalances(
    actor: LedgerActor,
    balances: Partial<Record<"CAD" | "USD" | "EUR" | "GBP", string>>,
  ) {
    return withSerializationRetry(() => this.initializeBalancesOnce(actor, balances));
  }

  private async initializeBalancesOnce(
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
      const mark = await client.query(
        `SELECT generation::text AS generation
           FROM ledger_till_balance_generations
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5`,
        scope(actor),
      );
      await client.query("COMMIT");
      return {
        tillId: actor.tillId,
        balanceGeneration: mark.rows[0]?.generation ?? "0",
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
      const role = await authorizeLedgerActor(client, actor, "ledger:view");
      const result = await client.query(
        /* Deals only. A cheque clearance and a cheque return each write a
           journal and therefore each need a transaction row to hang it
           off, but neither is a deal somebody did at the counter — and
           this list becomes the browser's `rows`, which the Ledger screen
           counts, the Dashboard totals and the compliance engine
           aggregates as cash movement. One cheque appearing there three
           times would count its face amount three times over, in the
           aggregate that decides whether a report is owed. The list of
           settlement kinds lives in cheques.ts; a second copy of it here
           is where the next disagreement starts. */
        `SELECT t.*,r.reversal_id,r.reason AS reversal_reason,r.posted_at AS reversed_at
           FROM ledger_transactions t
           LEFT JOIN ledger_reversals r ON r.transaction_id=t.transaction_id
          WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
            AND t.workspace_id=$4 AND t.till_id=$5
            AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
          ORDER BY t.posted_at DESC,t.transaction_id DESC
          LIMIT $6`,
        [...scope(actor), limit],
      );
      await client.query("COMMIT");
      return redactDeskEarnings(role, {
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
          /* What the deal actually earned, against what the cash it handed
             over had cost — null on a purchase, because buying earns
             nothing. See docs/COST_BASIS.md. */
          costOfSaleHome: row.cost_of_sale_home ?? null,
          realizedPnlHome: row.realized_pnl_home ?? null,
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
          /* What KIND of deal, and what actually crossed the counter.
             The browser used to label every server row "Currency
             Exchange" because that was the only thing the book could
             hold. It now holds cheque cashings too, and a screen that
             calls one an exchange is a screen lying about a deal type on
             the same row it prints the amount of. */
          dealKind: row.deal_kind ?? "exchange",
          receivedInstrument: row.received_instrument ?? "cash",
          disbursedInstrument: row.disbursed_instrument ?? "cash",
          postedAt: new Date(row.posted_at).toISOString(),
          reversal: row.reversal_id
            ? {
                reversalId: row.reversal_id,
                reason: row.reversal_reason,
                postedAt: new Date(row.reversed_at).toISOString(),
              }
            : null,
        })),
      });
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
      const role = await authorizeLedgerActor(client, actor, "ledger:view");
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
      return redactDeskEarnings(role, {
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
      });
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

function customerJson(row: Record<string, unknown>, displayed: DisplayedDocument | null = null) {
  const idStatus = row.id_status as "verified" | "expired" | "missing";
  const idStanding: IdStanding =
    idStatus === "verified" || idStatus === "expired" || idStatus === "missing"
      ? toIdStanding(idStatus)
      : "missing";
  return {
    customerId: row.customer_id,
    externalRef: row.external_ref ?? null,
    clientId: row.client_id ?? null,
    name: row.name,
    risk: row.risk,
    idStatus,
    idStanding,
    displayedDocument: displayed,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

/* The client has to belong to this tenant and legal entity. A client
   id from another shop must not be written onto this till's customer. */
async function assertClientInEntity(
  client: pg.PoolClient,
  actor: LedgerActor,
  clientId: string,
) {
  const found = await client.query(
    `SELECT client_id FROM desk_clients
      WHERE client_id=$1 AND tenant_id=$2 AND legal_entity_id=$3`,
    [clientId, actor.tenantId, actor.legalEntityId],
  );
  if (!found.rowCount) {
    throw new LedgerError(
      "CLIENT_NOT_IN_ENTITY",
      "That client is not on this desk's records.",
    );
  }
}

async function linkedCustomerId(
  client: pg.PoolClient,
  actor: LedgerActor,
  clientId: string,
): Promise<string | null> {
  const found = await client.query(
    `SELECT customer_id FROM ledger_customers
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4
        AND client_id=$5
      LIMIT 1`,
    [...scope(actor).slice(0, 4), clientId],
  );
  return (found.rows[0]?.customer_id as string | undefined) ?? null;
}
