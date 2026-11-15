/* Canada exchange rules at post time.
   The home amount is the figure frozen on the quote (input times the
   frozen board mid). There is no Bank of Canada series in this book
   (#631). The gate uses that frozen figure, not a live rate and not
   the customer's price.
   Persona (PR 722) and sanctions screening (CD-217) are not called. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { civilToday } from "../civil-date.js";
import { cashReceived } from "../ledger/canada-rules.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import { checkStillLifts, confirmedHigh, loadShopCheck } from "./id-check.js";

const require = createRequire(import.meta.url);
const rules = require("../../../shared/exchange-v29.js") as {
  FX_ID: string;
  LARGE_CASH: string;
  isCanadaPack: (packId: string, home: string) => boolean;
  purposeRequired: (deal: string, window: string) => boolean;
  fxNeedsId: (deal: string) => boolean;
  fieldAnswer: (value: string, declined?: boolean) => { ok: boolean; stored: string; declined: boolean; tooLong?: boolean };
  occupationAnswer: (input: { code?: string | null; text?: string | null; allowedCodes: string[] }) => { ok: boolean; code: string | null; text: string | null; reason?: string };
  holdCounts: (hold: { cashMoved?: boolean; superseded?: boolean }) => boolean;
  holdMeterLabel: (hold: { cashMoved?: boolean }) => string | null;
  HELD_NOT_COUNTED: string;
  HOLD_FOOTER: string;
};
const rolling = require("../../../shared/rolling-24h.js") as {
  rollingWindow: (at: Date, hours?: number) => { start: Date; end: Date } | null;
};

export type HoldView = {
  holdId: string;
  status: string;
  cashMoved: boolean;
  cashHome: string | null;
  label: string | null;
  counted: boolean;
};

export type CashWindow = {
  postedTotal: string;
  heldCountedTotal: string;
  total: string;
  heldNotCounted: HoldView[];
  log: HoldView[];
  footer: string;
  start: Date;
  end: Date;
};

export type CanadaPlan = {
  applies: boolean;
  purpose: string;
  sourceOfFunds: string;
  declined: Array<"purpose" | "source_of_funds">;
  occupation: { kind: "individual" | "entity"; code: string | null; text: string | null } | null;
  lctrGap: boolean;
  window: { start: Date; end: Date; total: string } | null;
};

const empty = (purpose: string, source: string): CanadaPlan => ({
  applies: false,
  purpose,
  sourceOfFunds: source,
  declined: [],
  occupation: null,
  lctrGap: false,
  window: null,
});

export async function loadCashWindow(
  client: pg.PoolClient,
  legalEntityId: string,
  customerId: string,
  at: Date,
  exceptHoldId?: string | null,
): Promise<CashWindow> {
  const window = rolling.rollingWindow(at, 24);
  if (!window) {
    throw new LedgerError("COMPLIANCE_BLOCKED", "The 24 hour cash total could not be read. Nothing was posted.");
  }
  const posted = await cashReceived(client, legalEntityId, window, "conductor", customerId);
  const holds = await client.query(
    `SELECT hold_id, status, cash_moved, cash_home::text AS cash_home
       FROM exchange_holds
      WHERE legal_entity_id = $1 AND customer_id = $2
        AND created_at >= $3 AND created_at < $4
        AND superseded_by IS NULL
        AND ($5::text IS NULL OR hold_id <> $5)`,
    [legalEntityId, customerId, window.start, window.end, exceptHoldId ?? null],
  );
  let heldCounted = new Decimal(0);
  const heldNotCounted: HoldView[] = [];
  const log: HoldView[] = [];
  for (const row of holds.rows) {
    const view: HoldView = {
      holdId: String(row.hold_id),
      status: String(row.status),
      cashMoved: row.cash_moved === true,
      cashHome: row.cash_home == null ? null : String(row.cash_home),
      label: null,
      counted: false,
    };
    if (rules.holdCounts({ cashMoved: view.cashMoved, superseded: false })) {
      heldCounted = heldCounted.add(new Decimal(view.cashHome || "0"));
      view.counted = true;
    } else if (!view.cashMoved && view.status === "open") {
      view.label = rules.HELD_NOT_COUNTED;
      heldNotCounted.push(view);
    }
    log.push(view);
  }
  const total = posted.add(heldCounted);
  return {
    postedTotal: posted.toFixed(2),
    heldCountedTotal: heldCounted.toFixed(2),
    total: total.toFixed(2),
    heldNotCounted,
    log,
    footer: rules.HOLD_FOOTER,
    start: window.start,
    end: window.end,
  };
}

async function subjectKind(
  client: pg.PoolClient,
  legalEntityId: string,
  customerId: string,
): Promise<"individual" | "entity"> {
  const found = await client.query(
    `SELECT d.kind
       FROM ledger_customers c
       LEFT JOIN desk_clients d
         ON d.client_id = c.client_id AND d.legal_entity_id = c.legal_entity_id
      WHERE c.customer_id = $1 AND c.legal_entity_id = $2`,
    [customerId, legalEntityId],
  );
  return String(found.rows[0]?.kind || "") === "business" ? "entity" : "individual";
}

async function occupationCodes(client: pg.PoolClient, kind: "individual" | "entity"): Promise<string[]> {
  const found = await client.query(
    `SELECT code FROM fx_occupation_options
      WHERE active AND applies_to IN ($1, 'both')
      ORDER BY sort_order, code`,
    [kind],
  );
  return found.rows.map((row) => String(row.code));
}

export async function prepareCanadaExchange(
  client: pg.PoolClient,
  args: {
    packId: string;
    home: string;
    kind: string;
    amountHome: Decimal;
    legalEntityId: string;
    customerId: string;
    purpose: string;
    sourceOfFunds: string;
    occupationCode?: string | null;
    occupationText?: string | null;
    clientLeft?: boolean;
    holdId?: string | null;
    at?: Date;
  },
): Promise<CanadaPlan> {
  if (args.kind !== "exchange" || !rules.isCanadaPack(args.packId, args.home)) {
    return empty(args.purpose, args.sourceOfFunds);
  }
  const amount = args.amountHome.toFixed(2);
  const window = await loadCashWindow(client, args.legalEntityId, args.customerId, args.at ?? new Date(), args.holdId);
  const withThis = new Decimal(window.total).add(args.amountHome);
  const plan: CanadaPlan = {
    applies: true,
    purpose: args.purpose,
    sourceOfFunds: args.sourceOfFunds,
    declined: [],
    occupation: null,
    lctrGap: false,
    window: { start: window.start, end: window.end, total: withThis.toFixed(2) },
  };
  const today = civilToday();
  const shopCheck = await loadShopCheck(client, args.legalEntityId, args.customerId);
  const high = await confirmedHigh(client, args.legalEntityId, args.customerId);
  const idOk = checkStillLifts(shopCheck, today, high);

  if (rules.fxNeedsId(amount)) {
    if (!idOk) {
      throw new LedgerError(
        "ID_CHECK_REQUIRED",
        "This exchange is CAD 3,000 or more. It cannot post until the client's ID is checked at this shop.",
      );
    }
    const kind = await subjectKind(client, args.legalEntityId, args.customerId);
    const allowed = await occupationCodes(client, kind);
    const occupation = rules.occupationAnswer({
      code: args.occupationCode,
      text: args.occupationText,
      allowedCodes: allowed,
    });
    if (!occupation.ok) {
      throw new LedgerError(
        "OCCUPATION_REQUIRED",
        occupation.reason === "declined"
          ? "Occupation cannot be recorded as Client declined."
          : "An exchange of CAD 3,000 or more needs an occupation, or for a business the nature of its principal business.",
      );
    }
    plan.occupation = { kind, code: occupation.code, text: occupation.text };
  }

  if (rules.purposeRequired(amount, withThis.toFixed(2))) {
    const purpose = rules.fieldAnswer(args.purpose, false);
    const source = rules.fieldAnswer(args.sourceOfFunds, false);
    if (purpose.tooLong || source.tooLong) {
      throw new LedgerError("INVALID_REQUEST", "Purpose and source of funds must be at most 500 characters.");
    }
    if (!purpose.ok) {
      throw new LedgerError(
        "PURPOSE_REQUIRED",
        "Cash of CAD 10,000 or more needs a purpose. Record what the client said, or Client declined.",
      );
    }
    if (!source.ok) {
      throw new LedgerError(
        "SOURCE_REQUIRED",
        "Cash of CAD 10,000 or more needs the source of funds. Record what the client said, or Client declined.",
      );
    }
    plan.purpose = purpose.stored;
    plan.sourceOfFunds = source.stored;
    if (purpose.declined) plan.declined.push("purpose");
    if (source.declined) plan.declined.push("source_of_funds");
  }

  const small = args.amountHome.lt(rules.FX_ID) && args.amountHome.lt(rules.LARGE_CASH);
  if (small && withThis.gte(rules.LARGE_CASH) && !idOk) {
    if (!args.clientLeft) {
      throw new LedgerError(
        "ID_CHECK_REQUIRED",
        "Cash in the last 24 hours is CAD 10,000 or more. Check the client's ID, or record that the client has already left.",
      );
    }
    plan.lctrGap = true;
  }
  return plan;
}

export async function writeCanadaExchangeFacts(
  client: pg.PoolClient,
  actor: LedgerActor,
  transactionId: string,
  customerId: string,
  plan: CanadaPlan,
): Promise<void> {
  if (!plan.applies) return;
  if (plan.occupation) {
    await client.query(
      `INSERT INTO exchange_deal_facts (transaction_id, subject_kind, occupation_code, occupation_text)
       VALUES ($1,$2,$3,$4)`,
      [transactionId, plan.occupation.kind, plan.occupation.code, plan.occupation.text],
    );
  }
  for (const kind of plan.declined) {
    await client.query(
      `INSERT INTO compliance_review_items
         (item_id, tenant_id, legal_entity_id, branch_id, customer_id, transaction_id, kind, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        `rev_${randomUUID()}`, actor.tenantId, actor.legalEntityId, actor.branchId,
        customerId, transactionId,
        kind === "purpose" ? "purpose_declined" : "source_declined",
        JSON.stringify({ field: kind }),
      ],
    );
  }
  if (plan.lctrGap && plan.window) {
    const note = "The client had already left when cash in 24 hours reached CAD 10,000. ID was not checked at this shop. Prepared only. Not filed.";
    await client.query(
      `INSERT INTO lctr_prepare_drafts
         (draft_id, tenant_id, legal_entity_id, branch_id, customer_id, transaction_id, status,
          cash_total, client_left_gap, gap_note, window_start, window_end, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'prepared',$7,true,$8,$9,$10,$11)`,
      [
        `lctr_${randomUUID()}`, actor.tenantId, actor.legalEntityId, actor.branchId,
        customerId, transactionId, plan.window.total, note, plan.window.start, plan.window.end, actor.userId,
      ],
    );
    await client.query(
      `INSERT INTO compliance_review_items
         (item_id, tenant_id, legal_entity_id, branch_id, customer_id, transaction_id, kind, detail)
       VALUES ($1,$2,$3,$4,$5,$6,'lctr_client_left',$7)`,
      [
        `rev_${randomUUID()}`, actor.tenantId, actor.legalEntityId, actor.branchId,
        customerId, transactionId, JSON.stringify({ gap: true, preparedOnly: true }),
      ],
    );
  }
}

export async function supersedeHold(
  client: pg.PoolClient,
  legalEntityId: string,
  holdId: string | null | undefined,
  transactionId: string,
): Promise<void> {
  if (!holdId) return;
  await client.query(
    `UPDATE exchange_holds SET status = 'picked_up', superseded_by = $3
      WHERE hold_id = $1 AND legal_entity_id = $2 AND superseded_by IS NULL`,
    [holdId, legalEntityId, transactionId],
  );
}
