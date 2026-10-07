/* ============================================================
   Which country's rules is this desk operating under?

   The book used to answer "Canada" by not asking. Home currency was a
   string literal in half a dozen files and a suffix on a dozen column
   names, which is fine for one desk in Toronto and useless for selling
   the same product in London.

   A jurisdiction is now a pack a legal entity points at: what currency
   the books are kept in, who the regulator is, what has to be reported
   and over what, and whether foreign-to-foreign deals are permitted.

   A new posting stamps the pack id and version it was posted under, so
   installing a new pack — or correcting a threshold — does not change
   what already happened. Rows written before that stamp was added are
   left as they are.
   ============================================================ */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type pg from "pg";

export type JurisdictionPack = {
  packId: string;
  jurisdiction: string;
  version: number;
  name: string;
  homeCurrency: string;
  regulator: string;
  reportName: string;
  reportThreshold: string;
  idThreshold: string;
  reportCurrency: string;
  allowCrossCurrency: boolean;
  permittedCurrencies: string[];
  /* What this country's pack SUGGESTS inventory is costed by. A suggestion
     only — `legal_entities.cost_method` overrides it, and an owner anywhere
     may run FIFO whether their pack proposes it or not. See
     server/src/ledger/cost-method.ts. */
  defaultCostMethod: "weighted_average" | "fifo";
  /* False only when even the international baseline row is missing.
     The thresholds on that object are empty. They are not Canada's. */
  available: boolean;
  /* country — a seeded country pack. baseline — the international
     rules, not tied to a country. A baseline desk keeps its own home
     currency; the pack row's currency is only the currency the rules
     are written in. */
  kind: "country" | "baseline";
  baseline: boolean;
};

/* The international baseline. Not a country, and not Canada's pack. */
export const BASELINE_PACK_ID = "pack-intl-v1";

export const BASELINE_NOTICE =
  "We don't have rules for your country yet. These are the international anti-money-laundering rules. Please check they match your country's laws.";

/* The four kinds of deal an identification line can name.
   fx — foreign exchange
   remittance — a money transfer
   eft — an electronic funds transfer
   virtual_currency — a virtual-currency deal */
export const ID_DEAL_KINDS = ["fx", "remittance", "eft", "virtual_currency"] as const;
export type IdDealKind = (typeof ID_DEAL_KINDS)[number];

/* The setup screen asks one question, "when do you take ID?". That
   question is about foreign exchange, the deal at the counter. The
   other three lines stay on the pack. */
export const SETUP_ID_DEAL: IdDealKind = "fx";

/* Shown only when the baseline row itself is missing. A desk whose
   country has no pack is not paused: it trades under that baseline. */
export const RULES_UNAVAILABLE_NOTICE =
  "This desk has no rules pack installed, so a new deal cannot be posted.";

export type InstalledPack = {
  packId: string;
  version: number;
  homeCurrency: string;
};

/* The pack already written on a deal, carried onto a later row that
   settles or clears it. A missing id, a blank id, and a pack that was
   never stamped are the same answer: NULL. An empty string is not a
   pack, and a foreign key would reject it if one were added later. */
export function carriedPackStamp(row: {
  jurisdiction_pack_id?: unknown;
  jurisdiction_pack_version?: unknown;
} | undefined): { packId: string | null; packVersion: number | null } {
  const raw = row?.jurisdiction_pack_id;
  const packId = raw == null ? "" : String(raw).trim();
  if (!packId) return { packId: null, packVersion: null };
  const version = row?.jurisdiction_pack_version;
  if (version == null || version === "") return { packId, packVersion: null };
  const parsed = Number(version);
  return { packId, packVersion: Number.isInteger(parsed) ? parsed : null };
}

/* The baseline row itself is missing. Home currency is whatever the
   entity already booked in. Nothing is filled in from Canada. */
const unavailablePack = (homeCurrency: string): JurisdictionPack => ({
  packId: "",
  jurisdiction: "",
  version: 0,
  name: "",
  homeCurrency,
  regulator: "",
  reportName: "",
  reportThreshold: "",
  idThreshold: "",
  reportCurrency: "",
  allowCrossCurrency: true,
  permittedCurrencies: [],
  defaultCostMethod: "weighted_average",
  available: false,
  kind: "country",
  baseline: false,
});

const fromRow = (row: Record<string, unknown>): JurisdictionPack => ({
  packId: String(row.pack_id),
  jurisdiction: String(row.jurisdiction),
  version: Number(row.version),
  name: String(row.name),
  homeCurrency: String(row.home_currency).trim().toUpperCase(),
  regulator: String(row.regulator),
  reportName: String(row.report_name),
  reportThreshold: String(row.report_threshold),
  idThreshold: String(row.id_threshold),
  reportCurrency: String(row.report_currency).trim().toUpperCase(),
  allowCrossCurrency: Boolean(row.allow_cross_currency),
  permittedCurrencies: Array.isArray(row.permitted_currencies)
    ? (row.permitted_currencies as string[]).map((c) => String(c).toUpperCase())
    : [],
  defaultCostMethod:
    row.default_cost_method === "fifo" ? "fifo" : "weighted_average",
  available: true,
  kind: row.kind === "baseline" ? "baseline" : "country",
  baseline: row.kind === "baseline",
});

function bookCurrency(value: unknown): string {
  const code = value == null ? "" : String(value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

/* A baseline pack is written in USD. The desk's book is the currency
   the entity named, or USD when it named none. A country pack keeps
   the currency on the pack. */
function withBookCurrency(pack: JurisdictionPack, entityHome: unknown): JurisdictionPack {
  if (!pack.baseline) return pack;
  const home = bookCurrency(entityHome) || "USD";
  return home === pack.homeCurrency ? pack : { ...pack, homeCurrency: home };
}

/**
 * The pack a legal entity operates under, inside the caller's transaction.
 *
 * Read per posting rather than cached, because a pack is small and a stale
 * home currency would misprice a trade — the wrong kind of thing to hold in
 * memory to save a query.
 */
export async function resolvePack(
  client: pg.PoolClient,
  legalEntityId: string,
): Promise<JurisdictionPack> {
  const found = await client.query(
    `SELECT p.*, e.home_currency AS entity_home_currency
       FROM legal_entities e
       JOIN jurisdiction_packs p ON p.pack_id = e.jurisdiction_pack_id
      WHERE e.id = $1`,
    [legalEntityId],
  );
  if (found.rowCount) {
    return withBookCurrency(fromRow(found.rows[0]), found.rows[0].entity_home_currency);
  }

  /* No country pack on the entity. The international baseline applies.
     It is not the Canada pack. If that row is missing too, the desk
     has nothing to post a new deal under. */
  const entity = await client.query(
    "SELECT home_currency FROM legal_entities WHERE id=$1",
    [legalEntityId],
  );
  const entityHome = entity.rows[0]?.home_currency;
  const baseline = await client.query(
    "SELECT * FROM jurisdiction_packs WHERE pack_id=$1",
    [BASELINE_PACK_ID],
  );
  if (!baseline.rowCount) return unavailablePack(bookCurrency(entityHome));
  return withBookCurrency(fromRow(baseline.rows[0]), entityHome);
}

/** Is this pair tradeable under this pack, as a single deal? */
export function pairAllowed(
  pack: JurisdictionPack,
  from: string,
  to: string,
): { ok: true } | { ok: false; reason: string } {
  if (from === to) {
    return { ok: false, reason: "A deal needs two different currencies." };
  }
  const homeOnOneSide = from === pack.homeCurrency || to === pack.homeCurrency;
  if (!homeOnOneSide && !pack.allowCrossCurrency) {
    return {
      ok: false,
      reason: `${pack.name} desks trade against ${pack.homeCurrency}. Do this as two deals.`,
    };
  }
  if (pack.permittedCurrencies.length) {
    for (const code of [from, to]) {
      if (code !== pack.homeCurrency && !pack.permittedCurrencies.includes(code)) {
        return { ok: false, reason: `${code} is not permitted in ${pack.name}.` };
      }
    }
  }
  return { ok: true };
}

/* Country code → pack. The names underneath are the words the signup
   screen and the wizard already store ("Canada", "Somewhere else"),
   so a desk that said Canada by name still gets the Canada pack. */
export const PACK_FOR_COUNTRY: Readonly<Record<string, string>> = {
  CA: "pack-ca-v1",
  US: "pack-us-v1",
  GB: "pack-gb-v1",
  UK: "pack-gb-v1",
  EU: "pack-eu-v1",
  AU: "pack-au-v1",
  AE: "pack-ae-v1",
  HK: "pack-hk-v1",
};

const COUNTRY_CODE: Readonly<Record<string, string>> = {
  CA: "CA",
  CANADA: "CA",
  US: "US",
  USA: "US",
  "UNITED STATES": "US",
  GB: "GB",
  UK: "UK",
  "UNITED KINGDOM": "GB",
  EU: "EU",
  "EUROPEAN UNION": "EU",
  EUROZONE: "EU",
  AU: "AU",
  AUSTRALIA: "AU",
  AE: "AE",
  UAE: "AE",
  "UNITED ARAB EMIRATES": "AE",
  HK: "HK",
  "HONG KONG": "HK",
  "HONG KONG SAR": "HK",
  HKSAR: "HK",
};

export const HOME_FOR_PACK: Readonly<Record<string, string>> = {
  "pack-ca-v1": "CAD",
  "pack-us-v1": "USD",
  "pack-gb-v1": "GBP",
  "pack-eu-v1": "EUR",
  "pack-au-v1": "AUD",
  "pack-ae-v1": "AED",
  "pack-hk-v1": "HKD",
};

/**
 * The pack a new desk in this country should point at.
 * Null when that country has no pack. It is not the Canada pack.
 */
export function packForCountry(
  country: string | null | undefined,
): InstalledPack | null {
  const raw = String(country ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const code = COUNTRY_CODE[raw];
  if (!code) return null;
  const packId = PACK_FOR_COUNTRY[code];
  if (!packId) return null;
  const homeCurrency = HOME_FOR_PACK[packId];
  if (!homeCurrency) return null;
  return { packId, version: 1, homeCurrency };
}

/** A country that is known to have a pack. Used where the caller is Canada on purpose. */
export function requirePackForCountry(country: string): InstalledPack {
  const pack = packForCountry(country);
  if (!pack) {
    throw new Error(`No jurisdiction pack is installed for ${country}.`);
  }
  return pack;
}

/* One identification line, as a tagged result. No floats.
   not_applicable — this kind of deal has no line
   every_deal     — zero, so every deal of this kind
   amount         — a positive amount, as a Decimal
   unavailable    — the pack tables are not on this database */
export type PackIdLine =
  | { status: "not_applicable" }
  | { status: "every_deal" }
  | { status: "amount"; amount: Decimal }
  | { status: "unavailable" };

/* Only a missing table. Any other database error is a real failure
   and has to reach the caller. Drizzle sometimes wraps the driver
   error, so the code is read on the error and on its cause. */
function undefinedTable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: string }).code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* Read one identification line off the pack.
   A database without the pack tables — the embedded one, which does
   not run these migrations — falls back to the pack's single
   id_threshold. Zero on that old column means the number was never
   stated, so it is not_applicable. It never falls back to the report
   threshold. */
export async function packIdThreshold(
  db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  packId: string,
  dealKind: IdDealKind,
): Promise<PackIdLine> {
  const first = (found: unknown): Record<string, unknown> | undefined => {
    const rows =
      (Array.isArray(found) ? found : (found as { rows?: unknown[] }).rows) ?? [];
    return rows[0] as Record<string, unknown> | undefined;
  };
  const classify = (value: unknown, allowZero: boolean): PackIdLine => {
    if (value === null || value === undefined || value === "") {
      return { status: "not_applicable" };
    }
    let parsed: Decimal;
    try {
      parsed = new Decimal(String(value));
    } catch {
      return { status: "not_applicable" };
    }
    if (!parsed.isFinite() || parsed.isNegative()) return { status: "not_applicable" };
    if (parsed.isZero()) {
      return allowZero ? { status: "every_deal" } : { status: "not_applicable" };
    }
    return { status: "amount", amount: parsed };
  };
  try {
    const row = first(
      await db.execute(
        sql`SELECT threshold FROM jurisdiction_id_thresholds WHERE pack_id = ${packId} AND deal_kind = ${dealKind}`,
      ),
    );
    if (row && "threshold" in row) return classify(row.threshold, true);
  } catch (error) {
    if (!undefinedTable(error)) throw error;
  }
  try {
    const row = first(
      await db.execute(
        sql`SELECT id_threshold FROM jurisdiction_packs WHERE pack_id = ${packId}`,
      ),
    );
    if (!row) return { status: "unavailable" };
    return classify(row.id_threshold, false);
  } catch (error) {
    if (!undefinedTable(error)) throw error;
    return { status: "unavailable" };
  }
}
