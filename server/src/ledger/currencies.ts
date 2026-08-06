/* ============================================================
   WHAT A CURRENCY IS, AND HOW MANY DECIMAL PLACES IT HAS.

   Both of those used to be answered by a literal, in ten places.

   `ledger/routes.ts` validated every currency on every money route with
   `z.enum(["CAD", "USD", "EUR", "GBP"])` — five times — and pinned four
   more schemas (till counts, opening balances, vault balances, unit
   costs) to those same four keys. Four service files carried a matching
   `type Currency = "CAD" | "USD" | "EUR" | "GBP"`, and the browser held
   its own copy in `os-src/cdos-os.jsx`. Nothing
   about the ledger needs that: `ledger_till_balances.currency` is a
   `char(3)`, the journal does not care, and the jurisdiction packs ship
   six home currencies. It was a placeholder from the pilot that became a
   ceiling.

   What it cost: this product's largest feature is remittance, its seeded
   corridors are the Philippines, India, China, Mexico and the UAE, and a
   Toronto desk running a Philippine corridor could not put a peso in a
   till. Not "it was awkward" — the route rejected the request. A shop
   whose whole business is PHP could open a drawer with no way to record
   the cash in it.

   ---- THE OTHER HALF: DECIMAL PLACES ----

   Every amount in this codebase is validated as `\d+(\.\d{1,2})?` and
   stored as `numeric(24,2)`. That is right for most of the world and
   wrong in both directions:

     JPY, KRW, VND, CLP …   ZERO minor units. There is no such thing as
                            ¥1,234.56. A payout quoted to two decimals is
                            not a rounding nicety, it is a figure a teller
                            cannot count out.
     KWD, BHD, OMR, JOD …   THREE minor units. A `numeric(24,2)` column
                            cannot hold one, and truncating silently is
                            how a desk loses a thousandth of a dinar per
                            deal and never finds out.

   So minor units are stated here, per ISO 4217, and enforced at the edge.
   Zero-decimal currencies are carried properly — `parseMoney` refuses
   `1234.56` for JPY the way it refuses `1.234` for USD.

   Three-decimal currencies are REFUSED, out loud, with the reason. The
   money columns hold two places; a desk that could add KWD to its set
   and then watch every amount quietly lose its third decimal is worse
   off than one told plainly that the ledger does not carry it yet.
   Widening 47 numeric(24,2) columns is its own change with its own
   migration, and pretending otherwise here is exactly the kind of
   silent-wrongness docs/ABSENT_FIGURES.md exists to forbid.
   ============================================================ */
import Decimal from "decimal.js";
import { LedgerError } from "./service.js";

/** The scale the ledger's money columns actually hold. */
export const LEDGER_SCALE = 2;

/* ISO 4217 exponents for everything this product can reach — the
   indicative board in ../rates/starting-board.ts, the pack home
   currencies, and the corridors. Anything not named here is treated as
   two, which is true of the overwhelming majority of ISO 4217 and is the
   assumption the whole codebase already made; naming the exceptions is
   what makes that assumption safe rather than lucky. */
const EXCEPTIONS: Readonly<Record<string, number>> = {
  /* no minor unit at all */
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0,
  XPF: 0,
  /* three, and therefore not storable at the ledger's scale */
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** ISO 4217 minor units for a code — 2 unless it is one of the exceptions. */
export function minorUnits(code: string): number {
  return EXCEPTIONS[code.toUpperCase()] ?? 2;
}

/** The shape of a currency code. Not whether this desk trades it. */
export function isCurrencyCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code.trim().toUpperCase());
}

/** Normalized, or null if it is not a currency code at all. */
export function asCurrencyCode(code: unknown): string | null {
  return isCurrencyCode(code) ? String(code).trim().toUpperCase() : null;
}

/**
 * Can the ledger hold amounts in this currency at all?
 *
 * False only for three-decimal currencies, and the reason travels with
 * the answer so a caller never has to invent one.
 */
export function carriable(
  code: string,
): { ok: true } | { ok: false; reason: string } {
  if (minorUnits(code) > LEDGER_SCALE) {
    return {
      ok: false,
      reason:
        `${code} is written to three decimal places, and this ledger's ` +
        `amounts hold two. It is not carried yet — recording it here ` +
        `would drop the third place on every deal.`,
    };
  }
  return { ok: true };
}

/**
 * An amount, in the number of places the currency actually has.
 *
 * The regex the rest of the codebase uses accepts two places for
 * everything, so `1234.56` passed as a JPY payout sailed through and was
 * stored as a figure no teller can count out. This asks the currency.
 */
export function parseMoney(
  value: string,
  currency: string,
  field: string,
  minimum: Decimal.Value = 0,
): Decimal {
  const places = minorUnits(currency);
  const carried = carriable(currency);
  if (!carried.ok) throw new LedgerError("UNSUPPORTED_CURRENCY", carried.reason);

  const pattern =
    places === 0
      ? /^(?:0|[1-9]\d{0,11})$/
      : new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${places}})?$`);
  if (!pattern.test(value)) {
    throw new LedgerError(
      "INVALID_REQUEST",
      places === 0
        ? `${field} is not a whole number of ${currency}. ${currency} has no minor unit.`
        : `${field} is not an amount in ${currency}, to ${places} decimal places.`,
    );
  }
  const out = new Decimal(value);
  if (out.lt(minimum) || out.gt("1000000000")) {
    throw new LedgerError(
      "INVALID_REQUEST",
      `${field} is outside the permitted range.`,
    );
  }
  return out.toDecimalPlaces(places);
}

/**
 * Round a computed figure to what the currency can actually be paid in.
 *
 * A payout, a converted amount, a fee — anything the ledger works out
 * rather than being handed. `1234.56` yen becomes `1235`, because the
 * alternative is a receipt asking for money that does not exist.
 */
export function roundTo(amount: Decimal, currency: string): Decimal {
  return amount.toDecimalPlaces(minorUnits(currency), Decimal.ROUND_HALF_UP);
}

/** A fixed-point string in the currency's own places. */
export function fixedIn(amount: Decimal, currency: string): string {
  const places = minorUnits(currency);
  return amount.toDecimalPlaces(places).toFixed(places);
}

/* ============================================================
   WHAT THIS DESK TRADES

   Home currency plus the stated set, and the stated set is
   `legal_entities.traded_currencies` — the answer onboarding has always
   collected and, until migration 020, only ever used to publish a rate
   board.

   NULL there is not an empty set. It means nobody has stated one, and
   nothing is restricted — see the note on the resolver below, which is
   the single most important decision in this file. The branch's board is
   read in that case too, but only to SUGGEST what a picker should offer;
   it constrains nothing.

   Three-decimal currencies are filtered OUT of whatever the answer
   would otherwise be. A desk that names KWD does not get a set that
   half-works; it gets a set without KWD, and `carriable()` is what says
   why to anybody who asks for it directly.
   ============================================================ */

export type DeskCurrencies = {
  /** the currency the books are kept in */
  home: string;
  /**
   * The set the OWNER stated, home included — or null, meaning they have
   * not stated one and the ledger is not going to invent it.
   */
  stated: string[] | null;
  /**
   * What a screen should offer: the stated set if there is one, else what
   * this branch's board already quotes. A suggestion for a dropdown, never
   * a rule — `tradeable` is the rule.
   */
  suggested: string[];
};

/* ---- the default is UNRESTRICTED, and that is the point ----

   The first version of this resolver fell back to the home currency
   alone when a desk had stated nothing. That is defensible on paper and
   was wrong in practice: it replaced a four-currency ceiling with a
   ONE-currency ceiling for every desk that had never filled the field
   in, which is all of them. Twenty-three tests failed and every one of
   them was right to.

   A restriction nobody stated is not a restriction. It is the same rule
   this codebase already follows for reporting lines — the pack proposes,
   the desk decides, and where neither has spoken the product does not
   invent an answer and act on it (docs/DESK_THRESHOLDS.md,
   docs/ABSENT_FIGURES.md).

   So: an owner who names their currencies gets exactly those and a
   refusal by name for anything else. An owner who has not gets any
   currency the ledger can carry. What is removed either way is the
   ceiling — nothing in the product decides for a shop that it does not
   trade pesos. */
export async function resolveDeskCurrencies(
  client: {
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  },
  args: { legalEntityId: string; branchId?: string; homeCurrency: string },
): Promise<DeskCurrencies> {
  const home = args.homeCurrency.trim().toUpperCase();
  const clean = (codes: unknown[]): string[] =>
    Array.from(
      new Set(
        codes
          .map((code) => asCurrencyCode(code))
          .filter((code): code is string => !!code && code !== home)
          .filter((code) => carriable(code).ok),
      ),
    ).sort();

  const row = await client.query(
    "SELECT traded_currencies FROM legal_entities WHERE id=$1",
    [args.legalEntityId],
  );
  const declared = row.rows[0]?.traded_currencies;
  if (Array.isArray(declared) && declared.length) {
    const set = clean(declared);
    if (set.length) {
      const stated = [home, ...set];
      return { home, stated, suggested: stated };
    }
  }

  /* Nobody stated a set. For a dropdown, the best available guess is what
     this branch's board already quotes — which came from the onboarding
     answer in the first place. It constrains nothing. */
  let suggested = [home];
  if (args.branchId) {
    const board = await client.query(
      `SELECT board_rows FROM rate_boards
        WHERE branch_id=$1 ORDER BY published_at DESC LIMIT 1`,
      [args.branchId],
    );
    const rows = board.rows[0]?.board_rows;
    if (rows && typeof rows === "object") {
      suggested = [home, ...clean(Object.keys(rows as Record<string, unknown>))];
    }
  }
  return { home, stated: null, suggested };
}

/**
 * Refuse, by name, any of these codes this desk does not trade.
 *
 * Called on the paths that can bring a NEW currency onto the book — a
 * deal, a till movement, a vault receipt, an opening position. It is
 * deliberately NOT called when counting a drawer or closing a till:
 * those deal with money that is already there, and a desk that drops a
 * currency from its set must still be able to count out what it holds.
 * Gating a close on the traded set would strand real cash.
 */
export async function assertTradeable(
  client: {
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  },
  args: { legalEntityId: string; branchId?: string; homeCurrency: string },
  ...codes: string[]
): Promise<DeskCurrencies> {
  const desk = await resolveDeskCurrencies(client, args);
  for (const code of codes) {
    const allowed = tradeable(desk, code);
    if (!allowed.ok) {
      throw new LedgerError(
        minorUnits(code) > LEDGER_SCALE ? "UNSUPPORTED_CURRENCY" : "CURRENCY_NOT_TRADED",
        allowed.reason,
      );
    }
  }
  return desk;
}

/**
 * May this desk deal in this currency? The reason travels with a refusal.
 *
 * Two ways to be refused, and only two. The ledger cannot carry the
 * currency at all (three decimal places), or the owner stated a set and
 * this is not in it. Where no set was stated there is nothing to be
 * outside of.
 */
export function tradeable(
  desk: DeskCurrencies,
  code: string,
): { ok: true } | { ok: false; reason: string } {
  const carried = carriable(code);
  if (!carried.ok) return carried;
  if (desk.stated && !desk.stated.includes(code)) {
    return {
      ok: false,
      reason:
        `This desk does not trade ${code}. Its currencies are ` +
        `${desk.stated.join(", ")} — add ${code} in Settings › ` +
        `Compliance & jurisdiction if it should.`,
    };
  }
  return { ok: true };
}
