/* The ID-document catalogue, on the server.

   The list itself is shared/id-document-types.js. The desk loads that
   same file as a plain script, so the server and the browser cannot
   disagree about which names exist or which name is a health card.
   This file only gives it types. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type IdDocumentKind = "person" | "business";

export type IdDocumentType = {
  readonly code: string;
  readonly label: string;
  readonly kind: IdDocumentKind;
  readonly photo: boolean;
  readonly mayLackExpiry: boolean;
  readonly acceptedAsId: boolean;
  readonly aliases: readonly string[];
};

export type WriteNormalisation =
  | { ok: true; label: string; code?: string }
  | { ok: false; code: "ID_TYPE_NOT_IN_CATALOGUE" | "HEALTH_CARD_NOT_ID"; detail: string };

type Catalogue = {
  ID_DOCUMENT_TYPES: readonly IdDocumentType[];
  HEALTH_CARD: string;
  NOT_STATED: string;
  HEALTH_CARD_REFUSAL: string;
  HEALTH_CARD_SHOWN: string;
  NOT_IN_CATALOGUE: string;
  HEALTH_CARD_KEYS: readonly string[];
  typeKey: (value: unknown) => string;
  resolveIdType: (value: unknown) => IdDocumentType | null;
  isNotStated: (value: unknown) => boolean;
  isHealthCardType: (value: unknown) => boolean;
  isAcceptedIdType: (value: unknown) => boolean;
  pickerLabels: (kind?: IdDocumentKind) => string[];
  shownIdType: (value: unknown) => string;
  notInCatalogueSentence: (labels: readonly string[]) => string;
  notAcceptedHereSentence: (label: string) => string;
  noLongerAcceptedSentence: (label: string) => string;
  normaliseForWrite: (value: unknown) => WriteNormalisation;
  scrubHealthNumbers: <T>(value: T) => T;
  typeKeySql: (expr: string) => string;
};

const catalogue = require("../../../shared/id-document-types.js") as Catalogue;

export const ID_DOCUMENT_TYPES = catalogue.ID_DOCUMENT_TYPES;
export const HEALTH_CARD = catalogue.HEALTH_CARD;
export const NOT_STATED = catalogue.NOT_STATED;
export const HEALTH_CARD_REFUSAL = catalogue.HEALTH_CARD_REFUSAL;
export const HEALTH_CARD_SHOWN = catalogue.HEALTH_CARD_SHOWN;
export const NOT_IN_CATALOGUE = catalogue.NOT_IN_CATALOGUE;
export const HEALTH_CARD_KEYS = catalogue.HEALTH_CARD_KEYS;
export const typeKey = catalogue.typeKey;
export const resolveIdType = catalogue.resolveIdType;
export const isNotStated = catalogue.isNotStated;
export const isHealthCardType = catalogue.isHealthCardType;
export const isAcceptedIdType = catalogue.isAcceptedIdType;
export const pickerLabels = catalogue.pickerLabels;
export const shownIdType = catalogue.shownIdType;
export const notInCatalogueSentence = catalogue.notInCatalogueSentence;
export const notAcceptedHereSentence = catalogue.notAcceptedHereSentence;
export const noLongerAcceptedSentence = catalogue.noLongerAcceptedSentence;
export const normaliseForWrite = catalogue.normaliseForWrite;
export const scrubHealthNumbers = catalogue.scrubHealthNumbers;
export const typeKeySql = catalogue.typeKeySql;
