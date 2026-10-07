/* Serbia receipt rules that the generic identification line does not cover.

   The National Bank of Serbia exchange decision (consolidated through
   24/2026) requires, on top of the anti-money-laundering amounts:

     Point 23: a receipt for every transaction. The thirteen fields are
     listed in docs/SERBIA_PACK.md. This module enforces the ones the
     desk can already refuse a deal for: the identity number when the
     identification line is met, and the serial numbers when 50 or 100
     US dollar notes are sold.

     Point 21 notice item 2: a sale of 50 or 100 US dollar notes to a
     natural person records the name, the JMBG or passport number, and
     the serial number of each note.

     Point 21 notice item 4: airside, or inside a casino, every buy and
     every sell records the name and the JMBG or passport number.

   Article 95 (keep five years, then delete, extension only by an
   authority) is not implemented here. Nothing in this file deletes a
   row or lengthens a retention period. */
import type pg from "pg";
import type { JurisdictionPack } from "./jurisdiction.js";
import type { LedgerActor } from "./service.js";

export const SERBIA_PACK_ID = "pack-rs-v1";

export const SERBIA_USD_NOTES_PROMPT =
  "Say whether this sale includes 50 or 100 US dollar notes.";

export const SERBIA_USD_NOTES_REQUIRED =
  "A sale of 50 or 100 US dollar notes needs the customer's name, their JMBG or passport number, and the serial number of each note.";

export const SERBIA_AIRSIDE_REQUIRED =
  "This counter is airside or in a casino. Every buy and sell needs the customer's name and their JMBG or passport number.";

export const SERBIA_RECEIPT_IDENTITY =
  "This receipt needs the customer's JMBG or passport number.";

export type SerbiaCapture = {
  identityNumber?: string | null;
  usdLargeNotes?: boolean | null;
  usdNoteSerials?: string[] | null;
};

export type SerbiaFacts =
  | {
      ok: true;
      identityNumber: string | null;
      noteSerials: string[] | null;
      receiptFacts: Record<string, unknown> | null;
    }
  | { ok: false; message: string };

function cleanIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  return trimmed;
}

function cleanSerials(value: string[] | null | undefined): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return null;
  const serials: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 40) return null;
    serials.push(trimmed);
  }
  return serials;
}

/* Purchase of foreign cash is otkup, basis 796 and 701. Sale of foreign
   cash is prodaja, basis 700 and 701. Both are the cash lines in Point
   23 item 7. A cross with no dinar side, and a cheque, are not guessed. */
function cashBasis(from: string, to: string): { side: string; basis: string } | null {
  if (from === "RSD" && to !== "RSD") return { side: "prodaja", basis: "700/701" };
  if (to === "RSD" && from !== "RSD") return { side: "otkup", basis: "796/701" };
  return null;
}

async function airside(client: pg.PoolClient, actor: LedgerActor): Promise<boolean> {
  const found = await client.query(
    `SELECT airside_or_casino
       FROM branches
      WHERE id = $1 AND tenant_id = $2`,
    [actor.branchId, actor.tenantId],
  );
  return found.rows[0]?.airside_or_casino === true;
}

/**
 * Receipt facts for one exchange, or a refusal.
 *
 * Any pack other than Serbia returns empty facts. The columns stay null
 * and the deal is not asked the Serbia questions.
 */
export async function serbiaExchangeFacts(
  client: pg.PoolClient,
  pack: JurisdictionPack,
  actor: LedgerActor,
  deal: {
    from: string;
    to: string;
    kind: string;
    cash: boolean;
    customerName: string;
    idStatus: unknown;
    rate: string;
  },
  identificationRequired: boolean,
  capture: SerbiaCapture,
): Promise<SerbiaFacts> {
  if (pack.packId !== SERBIA_PACK_ID) {
    return { ok: true, identityNumber: null, noteSerials: null, receiptFacts: null };
  }
  const exchange = deal.kind === "exchange" && deal.cash;
  const name = deal.customerName.trim();
  const identity = cleanIdentity(capture.identityNumber);
  const sellingUsd = exchange && deal.to === "USD";

  if (exchange && (await airside(client, actor))) {
    if (deal.idStatus !== "verified" || !name || !identity) {
      return { ok: false, message: SERBIA_AIRSIDE_REQUIRED };
    }
  }

  let noteSerials: string[] | null = null;
  if (sellingUsd) {
    if (typeof capture.usdLargeNotes !== "boolean") {
      return { ok: false, message: SERBIA_USD_NOTES_PROMPT };
    }
    if (capture.usdLargeNotes) {
      noteSerials = cleanSerials(capture.usdNoteSerials);
      if (!name || !identity || !noteSerials) {
        return { ok: false, message: SERBIA_USD_NOTES_REQUIRED };
      }
    }
  }

  if (identificationRequired && !identity) {
    return { ok: false, message: SERBIA_RECEIPT_IDENTITY };
  }

  const basis = exchange ? cashBasis(deal.from, deal.to) : null;
  return {
    ok: true,
    identityNumber: identity,
    noteSerials,
    receiptFacts: {
      side: basis?.side ?? null,
      basis: basis?.basis ?? null,
      rate: deal.rate,
      identityNumber: identity,
      noteSerials,
    },
  };
}
