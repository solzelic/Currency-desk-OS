/* ============================================================
   Which ID types a jurisdiction pack switches on, and which it locks.

   The catalogue (shared/id-document-types.js) is every type a desk can
   name. This file is what a pack says about those types. The owner
   chooses inside it, in Settings → Accepted IDs
   (server/src/clients/accepted-id-types.ts).

   THE DEFAULT. Every type the catalogue accepts as ID is on, in every
   pack. A desk that has never opened the setting keeps every type it
   could record before the setting existed.

   A LOCK. A pack can lock a type off, with a short legal note. A locked
   type is off whatever the owner stored, cannot be switched on, and the
   note is what Settings shows beside the padlock and what the refusal
   names.

   The health card is locked off in every pack. The catalogue already
   refuses a new one everywhere (`acceptedAsId: false`), so the lock
   adds no refusal. It is how Settings shows it. Canada's note names
   the rule that applies there.

   Keyed by the pack's jurisdiction (`jurisdiction_packs.jurisdiction`),
   so every version of one country's pack says the same thing. A later
   pack adds its own entry to PACK_ID_TYPE_RULES.
   ============================================================ */
import {
  HEALTH_CARD,
  ID_DOCUMENT_TYPES,
  type IdDocumentKind,
} from "../clients/id-document-types.js";

export type IdTypeLock = {
  /** a catalogue code */
  readonly code: string;
  /** the legal reason, in one or two plain sentences */
  readonly note: string;
};

export type PackIdTypeRules = {
  readonly locks: readonly IdTypeLock[];
};

/* A type the catalogue never accepts as ID, in a pack that says
   nothing more about it. Today that is only the health card. */
export const NEVER_ID_NOTE = "Health cards are not accepted as ID on CurrencyDesk.";

export const CANADA_HEALTH_CARD_NOTE =
  "FINTRAC says not to use a health card where provincial law forbids it. " +
  "Ontario's Health Cards and Numbers Control Act bars it.";

export const PACK_ID_TYPE_RULES: Readonly<Record<string, PackIdTypeRules>> = {
  /* FINTRAC's identity guidance says not to use a health card where
     provincial law prohibits it. Ontario's Health Cards and Numbers
     Control Act, 1991 bars a business outside health care from
     collecting or using a health number. The same reasons are in the
     header of shared/id-document-types.js. */
  CA: { locks: [{ code: HEALTH_CARD, note: CANADA_HEALTH_CARD_NOTE }] },
};

/** One catalogue type, as one pack sees it. */
export type IdTypeRule = {
  code: string;
  label: string;
  kind: IdDocumentKind;
  photo: boolean;
  /** on for a shop that has not stated its own list */
  packDefault: boolean;
  /** off, and the owner cannot switch it on */
  locked: boolean;
  /** why it is locked; null when it is not */
  note: string | null;
};

/**
 * Every catalogue type, in catalogue order, as this pack sees it.
 * `rules` is the table above; a test passes its own to show a later
 * pack locking something else.
 */
export function idTypeRulesFor(
  jurisdiction: string | null | undefined,
  rules: Readonly<Record<string, PackIdTypeRules>> = PACK_ID_TYPE_RULES,
): IdTypeRule[] {
  const pack = rules[String(jurisdiction ?? "").trim().toUpperCase()];
  const notes = new Map<string, string>();
  for (const lock of pack?.locks ?? []) notes.set(lock.code, lock.note);
  return ID_DOCUMENT_TYPES.map((row) => {
    const note = notes.get(row.code) ?? (row.acceptedAsId ? null : NEVER_ID_NOTE);
    const locked = note !== null;
    return {
      code: row.code,
      label: row.label,
      kind: row.kind,
      photo: row.photo,
      packDefault: row.acceptedAsId && !locked,
      locked,
      note,
    };
  });
}

/**
 * The codes a shop accepts: the pack's defaults when it has stated
 * nothing (NULL), otherwise what it stored, less anything the pack
 * locks. Catalogue order. A stored code the catalogue no longer has is
 * dropped rather than refused, so removing a type later breaks no desk.
 */
export function acceptedCodes(rules: readonly IdTypeRule[], stored: readonly string[] | null): string[] {
  if (stored === null) return rules.filter((rule) => rule.packDefault).map((rule) => rule.code);
  const wanted = new Set(stored);
  return rules
    .filter((rule) => !rule.locked && wanted.has(rule.code))
    .map((rule) => rule.code);
}

/** At least one person photo ID is on. Business types may all be off. */
export function keepsPhotoId(rules: readonly IdTypeRule[], codes: Iterable<string>): boolean {
  const on = new Set(codes);
  return rules.some((rule) => rule.kind === "person" && rule.photo && !rule.locked && on.has(rule.code));
}
