/* ============================================================
   Which country's rules is this desk operating under?

   The book used to answer "Canada" by not asking. Home currency was a
   string literal in half a dozen files and a suffix on a dozen column
   names, which is fine for one desk in Toronto and useless for selling
   the same product in London.

   A jurisdiction is now a pack a legal entity points at: what currency
   the books are kept in, who the regulator is, what has to be reported
   and over what, and whether foreign-to-foreign deals are permitted.

   Everything a desk posts snapshots the pack and version it was posted
   under, so installing a new pack — or correcting a threshold — can never
   change what already happened.
   ============================================================ */
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
};

/* The pilot's pack, used only when an entity has somehow not been given one
   — a database predating the packs, or a row created by a path that has not
   been taught about them yet. It is a floor, not a default anybody should
   be relying on, and `resolvePack` says so by preferring the real row. */
const PILOT: JurisdictionPack = {
  packId: "pack-ca-v1",
  jurisdiction: "CA",
  version: 1,
  name: "Canada",
  homeCurrency: "CAD",
  regulator: "FINTRAC",
  reportName: "LCTR",
  reportThreshold: "10000.00",
  idThreshold: "3000.00",
  reportCurrency: "CAD",
  allowCrossCurrency: true,
  permittedCurrencies: [],
};

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
});

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
    `SELECT p.*
       FROM legal_entities e
       JOIN jurisdiction_packs p ON p.pack_id = e.jurisdiction_pack_id
      WHERE e.id = $1`,
    [legalEntityId],
  );
  if (found.rowCount) return fromRow(found.rows[0]);

  /* No pack on the entity. Rather than guess a country, fall back to the
     entity's own home currency if it has one, and to the pilot only when it
     has neither — an entity created before any of this existed. */
  const entity = await client.query(
    "SELECT home_currency FROM legal_entities WHERE id=$1",
    [legalEntityId],
  );
  const home = entity.rows[0]?.home_currency;
  if (home) return { ...PILOT, homeCurrency: String(home).trim().toUpperCase() };
  return PILOT;
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

/* Country → pack. This is the "plug in a Canada pack or a UK pack" step:
   onboarding already asks which country the desk operates in, and that
   answer is what installs its rules, its regulator, its reporting
   thresholds and the currency its books are kept in.

   A country with no pack yet falls back to the pilot's, so a desk can still
   be created while its jurisdiction is being written — but it is recorded
   as Canadian rather than silently unlabelled, which is a state somebody
   can find and fix. */
export const PACK_FOR_COUNTRY: Readonly<Record<string, string>> = {
  CA: "pack-ca-v1",
  US: "pack-us-v1",
  GB: "pack-gb-v1",
  UK: "pack-gb-v1",
  EU: "pack-eu-v1",
  AU: "pack-au-v1",
  AE: "pack-ae-v1",
};

export const HOME_FOR_PACK: Readonly<Record<string, string>> = {
  "pack-ca-v1": "CAD",
  "pack-us-v1": "USD",
  "pack-gb-v1": "GBP",
  "pack-eu-v1": "EUR",
  "pack-au-v1": "AUD",
  "pack-ae-v1": "AED",
};

/** What a legal entity in this country should be created pointing at. */
export function packForCountry(country: string | null | undefined): {
  packId: string;
  version: number;
  homeCurrency: string;
} {
  const packId =
    PACK_FOR_COUNTRY[String(country ?? "").trim().toUpperCase()] ?? "pack-ca-v1";
  return { packId, version: 1, homeCurrency: HOME_FOR_PACK[packId] ?? "CAD" };
}
