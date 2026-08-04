/* ============================================================
   Where a filed report actually lives.

   The desk fills a worksheet — every field of the regulator's form in the
   regulator's own order, pre-filled from the ledger, the client record and
   the configuration — reads it down into the regulator's portal, pastes
   the acknowledgement number back, and the worksheet freezes into the
   sealed five-year copy. All of that was right. Where the sealed copy went
   was not: `localStorage`, in the browser of whichever till happened to be
   in front of the person who filed it.

   That is wrong in four separate ways and each one is its own incident.
   The record dies with the browser profile. The second till has a
   different set of filings from the first. The copy is unencrypted
   name-address-date-of-birth-document-number on a shared machine. And the
   store is bounded, so a busy desk eventually writes one more filing than
   fits and the browser throws a quota error into a `catch {}` — the screen
   says sealed, and nothing was kept.

   So a filing is a row here, and the browser holds a cache of it.

   AN AMENDMENT IS A NEW FILING, NOT AN EDIT

   Filing a correction used to overwrite the record in place, so two
   submissions to the regulator carrying two different acknowledgement
   numbers collapsed into one local record and the first sealed copy was
   deleted — by code that meant to be tidy. The database refuses that: the
   trigger from migration 012 raises on any update or delete of a filed
   row, and this service never tries. A correction is INSERTED, pointing at
   what it corrects through `amends_filing_id`, and both copies are
   retrievable forever.

   Nothing marks the amended row as superseded, because nothing can — it is
   sealed. "Was this filing later amended?" is answered by asking whether
   anything points at it, which is also the only answer that stays true.

   WHICH FORM, IN WHICH COUNTRY

   The browser sends the regulator's own short code — LCTR, CTR, MLR, TTR —
   and the report it belongs to is resolved from the pack the legal entity
   operates under. A desk in London filing an MLR and a desk in Toronto
   filing an LCTR run this same path and land on different rows of
   `jurisdiction_reports`. A code the pack does not have is refused rather
   than invented, for the reason migration 012 gives for seeding empty
   field lists: a form that looks official and is wrong is worse than no
   form at all.
   ============================================================ */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type FilingInput = {
  /* The regulator's short code for the form: LCTR, EFTR, STR, CTR, MLR… */
  reportCode: string;
  /* The desk's identifier for the obligation this discharges, carrying a
     fingerprint of the transaction set it covers. */
  obligationId: string;
  /* The same obligation without the set — who, what report, which day —
     so a later filing over a changed set can find this one. */
  obligationGroupId: string;
  reportRef: string;
  subjectName: string;
  reportedAmount: string | null;
  reportedCurrency: string | null;
  transactionRefs: string[];
  aggregationBasis: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  acknowledgementRef: string;
  /* Every field as submitted. Not a reference to today's records: a report
     re-rendered from live data is not the report that was filed, and the
     difference between those two is the whole reason to keep it. */
  payload: unknown;
  amendsFilingId: string | null;
};

export type Filing = {
  filingId: string;
  reportId: string;
  reportCode: string;
  packId: string;
  packVersion: number;
  status: string;
  obligationId: string | null;
  obligationGroupId: string | null;
  reportRef: string | null;
  subjectName: string | null;
  reportedAmount: string | null;
  reportedCurrency: string | null;
  transactionRefs: string[];
  aggregationBasis: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  acknowledgementRef: string | null;
  filedBy: string | null;
  filedAt: string | null;
  branchId: string;
  amendsFilingId: string | null;
  /* Filled in by the reader, not stored: the filing that supersedes this
     one, if any. Derived because the sealed row cannot be told. */
  amendedByFilingId: string | null;
  payload?: unknown;
};

const asRefs = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value == null ? null : String(value);

function toFiling(row: Record<string, unknown>, withPayload: boolean): Filing {
  const filing: Filing = {
    filingId: String(row.filing_id),
    reportId: String(row.report_id),
    reportCode: String(row.report_code),
    packId: String(row.pack_id),
    packVersion: Number(row.pack_version),
    status: String(row.status),
    obligationId: row.obligation_id == null ? null : String(row.obligation_id),
    obligationGroupId:
      row.obligation_group_id == null ? null : String(row.obligation_group_id),
    reportRef: row.report_ref == null ? null : String(row.report_ref),
    subjectName: row.subject_name == null ? null : String(row.subject_name),
    reportedAmount:
      row.reported_amount == null ? null : String(row.reported_amount),
    reportedCurrency:
      row.reported_currency == null ? null : String(row.reported_currency).trim(),
    transactionRefs: asRefs(row.subject_transaction_ids),
    aggregationBasis:
      row.aggregation_basis == null ? null : String(row.aggregation_basis),
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    acknowledgementRef:
      row.acknowledgement_ref == null ? null : String(row.acknowledgement_ref),
    filedBy: row.filed_by == null ? null : String(row.filed_by),
    filedAt: iso(row.filed_at),
    branchId: String(row.branch_id),
    amendsFilingId:
      row.amends_filing_id == null ? null : String(row.amends_filing_id),
    amendedByFilingId:
      row.amended_by_filing_id == null ? null : String(row.amended_by_filing_id),
  };
  if (withPayload) filing.payload = row.payload;
  return filing;
}

/* Every column except the payload. The list is read on every visit to the
   Filings screen and a sealed worksheet is tens of kilobytes of field
   values — nobody needs thirty of those to render a list of one-line rows. */
const LIST_COLUMNS = `f.filing_id, f.report_id, f.report_code, f.pack_id, f.pack_version,
        f.status, f.obligation_id, f.obligation_group_id, f.report_ref, f.subject_name,
        f.reported_amount, f.reported_currency, f.subject_transaction_ids,
        f.aggregation_basis, f.window_start, f.window_end, f.acknowledgement_ref,
        f.filed_by, f.filed_at, f.branch_id, f.amends_filing_id,
        (SELECT a.filing_id FROM ledger_report_filings a
          WHERE a.amends_filing_id = f.filing_id
          ORDER BY a.created_at DESC LIMIT 1) AS amended_by_filing_id`;

export class ReportFilingService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Every report this legal entity has filed, newest first.
   *
   * Scoped to the tenant and the legal entity rather than the branch: a
   * compliance obligation belongs to the registered entity, one report can
   * cover deals taken at more than one counter, and the owner asking "what
   * have we filed" is not asking about one till.
   */
  async list(actor: LedgerActor, limit = 200): Promise<{ filings: Filing[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const found = await client.query(
        `SELECT ${LIST_COLUMNS}
           FROM ledger_report_filings f
          WHERE f.tenant_id=$1 AND f.legal_entity_id=$2
          ORDER BY f.created_at DESC
          LIMIT $3`,
        [actor.tenantId, actor.legalEntityId, limit],
      );
      await client.query("COMMIT");
      return { filings: found.rows.map((row) => toFiling(row, false)) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** One filing with every field as submitted — the sealed copy itself. */
  async get(actor: LedgerActor, filingId: string): Promise<Filing> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const found = await client.query(
        `SELECT ${LIST_COLUMNS}, f.payload
           FROM ledger_report_filings f
          WHERE f.filing_id=$1 AND f.tenant_id=$2 AND f.legal_entity_id=$3`,
        [filingId, actor.tenantId, actor.legalEntityId],
      );
      await client.query("COMMIT");
      if (!found.rowCount) {
        throw new LedgerError(
          "FILING_NOT_FOUND",
          "That filing is not on this desk's record.",
        );
      }
      return toFiling(found.rows[0], true);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Seal a filing.
   *
   * Inserted, never updated. A correction names the filing it corrects and
   * becomes a second row; the first stays exactly as it was submitted,
   * which is what an examiner comparing the two needs.
   */
  async file(actor: LedgerActor, input: FilingInput): Promise<Filing> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      /* Reading the desk's filings and signing one in its name are two
         different authorities — an auditor has the first and must never
         have the second — so this asks for both rather than treating a
         reader as a filer. */
      await authorizeLedgerActor(client, actor, "ledger:view");
      await authorizeLedgerActor(client, actor, "compliance:file");

      const pack = await resolvePack(client, actor.legalEntityId);
      const code = input.reportCode.trim().toUpperCase();
      /* The pack's own catalogue of forms. Highest version wins: a
         jurisdiction that revises a form adds a version rather than
         restating the old one, because filings already made point at what
         they were made under. */
      const report = await client.query(
        `SELECT report_id, code
           FROM jurisdiction_reports
          WHERE pack_id=$1 AND upper(code)=$2
          ORDER BY version DESC
          LIMIT 1`,
        [pack.packId, code],
      );
      if (!report.rowCount) {
        throw new LedgerError(
          "REPORT_NOT_IN_PACK",
          `${pack.name} has no ${code} in its jurisdiction pack, so this desk cannot file one. Add the report to the pack before filing it.`,
        );
      }

      if (input.amendsFilingId) {
        const prior = await client.query(
          `SELECT status FROM ledger_report_filings
            WHERE filing_id=$1 AND tenant_id=$2 AND legal_entity_id=$3`,
          [input.amendsFilingId, actor.tenantId, actor.legalEntityId],
        );
        if (!prior.rowCount) {
          throw new LedgerError(
            "AMENDED_FILING_NOT_FOUND",
            "The filing this correction says it amends is not on this desk's record.",
          );
        }
      }

      const filingId = randomUUID();
      try {
        await client.query(
          `INSERT INTO ledger_report_filings
             (filing_id, tenant_id, legal_entity_id, branch_id, report_id,
              pack_id, pack_version, report_code, status, payload,
              subject_transaction_ids, subject_customer_ids,
              reported_amount, reported_currency, acknowledgement_ref,
              filed_by, filed_at, amends_filing_id, created_by,
              obligation_id, obligation_group_id, subject_name, report_ref,
              aggregation_basis, window_start, window_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'filed',$9,$10,$11,$12,$13,$14,$15,now(),$16,$15,
                   $17,$18,$19,$20,$21,$22,$23)`,
          [
            filingId,
            actor.tenantId,
            actor.legalEntityId,
            actor.branchId,
            report.rows[0].report_id,
            pack.packId,
            pack.version,
            String(report.rows[0].code),
            JSON.stringify(input.payload ?? {}),
            JSON.stringify(input.transactionRefs ?? []),
            JSON.stringify(input.subjectName ? [input.subjectName] : []),
            input.reportedAmount,
            input.reportedCurrency,
            input.acknowledgementRef,
            actor.userId,
            input.amendsFilingId,
            input.obligationId,
            input.obligationGroupId,
            input.subjectName,
            input.reportRef,
            input.aggregationBasis,
            input.windowStart,
            input.windowEnd,
          ],
        );
      } catch (error) {
        /* The partial unique index from migration 015. A second original
           filing of an obligation already filed is not a duplicate to
           swallow — it is somebody about to lose the first sealed copy,
           which is exactly what used to happen. Say what it is. */
        if ((error as { code?: string }).code === "23505") {
          throw new LedgerError(
            "OBLIGATION_ALREADY_FILED",
            "This obligation has already been filed. A correction is filed as a new report linked to the original — the sealed copy is never replaced.",
          );
        }
        throw error;
      }

      const found = await client.query(
        `SELECT ${LIST_COLUMNS}, f.payload
           FROM ledger_report_filings f
          WHERE f.filing_id=$1`,
        [filingId],
      );
      /* Filing a report is a compliance act, so it belongs in the trail
         beside the ones that move money. "Who filed the STR about this
         customer, and when" is a question somebody will ask. */
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          input.amendsFilingId ? "report.amend" : "report.file",
          filingId,
          `${String(report.rows[0].code)} ${input.reportRef} · ${input.subjectName} · ack ${input.acknowledgementRef}`,
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
      return toFiling(found.rows[0], true);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
