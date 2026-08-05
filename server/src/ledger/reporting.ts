/* ============================================================
   What the desk earned, and what it is holding — read from the book.

   Every headline figure on this product used to be computed in the
   browser from a demo seed: an owner's dashboard announced 38 deals,
   $130,566 of volume and a EUR SHORT position for a desk that had done
   one $1,000 trade and was LONG twelve thousand euros. Nothing crashed.
   Two books never do — see docs/CASH_OWNERSHIP_INVARIANTS.md.

   So the figures come from here, out of the ledger, in SQL. Three reads:

     summary()      what was posted over a window: deals, volume, fees,
                    and REALIZED profit, taken from the stored figure the
                    disposal wrote — never a spread against a market mid
     position()     what the branch physically holds, till and vault,
                    with its cost basis and — only where both halves are
                    actually known — its unrealized gain
     jurisdiction() which pack the desk trades under: home currency,
                    reporting threshold, the regulator's report name

   ---- THE RULE THESE ALL FOLLOW ----

   A figure the ledger cannot answer comes back NULL, and the screen shows
   it as absent. Not zero. Zero is a claim — "the desk earned nothing",
   "the safe holds nothing", "these notes cost nothing" — and only the
   book gets to make it. A period with no transactions has no volume to
   report; a balance that predates cost tracking has no basis; a currency
   the branch has never published a rate for has no market value. Each of
   those is `null` here and "—" on screen, with a line saying why.

   See docs/ABSENT_FIGURES.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { SETTLEMENT_DEAL_KINDS_SQL } from "./cheques.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { type LedgerActor } from "./service.js";

const tillScope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

const money = (value: Decimal.Value) =>
  new Decimal(value).toDecimalPlaces(2).toFixed(2);
const COST_PLACES = 12;

export type SummaryWindow = { from?: string; to?: string };

export class LedgerReportingService {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Totals over a window, for the till this session is signed in at.
   *
   * `from` and `to` are instants, and the CALLER decides where its day
   * begins. That is deliberate: a business day is a fact about a branch's
   * clock, and this server does not reliably know which timezone a branch
   * keeps — inventing one here would put every "today" figure an hour or
   * ten out without ever looking wrong. The till session carries the
   * business date the desk itself is working under, and the desk turns
   * that into the window it asks for.
   *
   * Reversed transactions are excluded from every total and counted
   * separately. A void is not a deal that earned nothing; it is a deal
   * that did not happen, and rolling it in as a zero would let a busy
   * morning of mistakes read as a busy morning.
   */
  async summary(actor: LedgerActor, window: SummaryWindow) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;

      /* The home-currency size of a deal is one of its two legs — whichever
         one IS the home currency. A cross between two foreign currencies has
         neither, and the row does not carry a home valuation, so it is
         counted as unvalued rather than converted at some rate nobody quoted.
         `market_mid` is a price between the two foreign sides; multiplying by
         it produces a number in neither currency. */
      /* SETTLEMENTS ARE NOT DEALS. A cheque clearance and a cheque return
         each carry a journal, so each is a transaction row; neither is
         something a customer did at the counter. Counted here, one cheque
         cashed and then cleared would read as two deals and twice its own
         face amount of volume — which is precisely the shape of wrong
         this whole file exists to have stopped. */
      const totals = await client.query(
        `WITH live AS (
           SELECT t.*,
                  COALESCE(t.fee_amount, t.fee_cad) AS fee_home,
                  CASE WHEN t.from_currency = $6 THEN t.input_amount
                       WHEN t.to_currency   = $6 THEN t.output_amount
                       ELSE NULL END AS volume_home
             FROM ledger_transactions t
             LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
            WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
              AND t.workspace_id=$4 AND t.till_id=$5
              AND r.reversal_id IS NULL
              AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
              AND ($7::timestamptz IS NULL OR t.posted_at >= $7)
              AND ($8::timestamptz IS NULL OR t.posted_at <  $8)
         )
         SELECT
           (SELECT count(*)::int FROM live) AS posted,
           (SELECT count(*)::int FROM ledger_transactions t
              JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
             WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
               AND t.workspace_id=$4 AND t.till_id=$5
               AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
               AND ($7::timestamptz IS NULL OR t.posted_at >= $7)
               AND ($8::timestamptz IS NULL OR t.posted_at <  $8)) AS reversed,
           (SELECT sum(volume_home) FROM live) AS volume_home,
           (SELECT count(*)::int FROM live WHERE volume_home IS NULL) AS unvalued,
           (SELECT sum(fee_home) FROM live) AS fees_home,
           (SELECT sum(realized_pnl_home) FROM live
             WHERE realized_pnl_home IS NOT NULL) AS realized_home,
           (SELECT sum(cost_of_sale_home) FROM live
             WHERE cost_of_sale_home IS NOT NULL) AS cost_of_sale_home,
           (SELECT count(*)::int FROM live
             WHERE realized_pnl_home IS NOT NULL) AS priced,
           (SELECT min(posted_at) FROM live) AS first_at,
           (SELECT max(posted_at) FROM live) AS last_at`,
        [...tillScope(actor), home, window.from ?? null, window.to ?? null],
      );
      const row = totals.rows[0];

      /* "Who earned what" — the line on the close-out sheet that gets
         signed. It used to be summed in the browser over its own record of
         the day's deals, and on a desk where one person had traded once
         and voided it the sign-off named THREE tellers with earnings
         beside them. Nobody had earned anything; the browser was adding up
         a seed.

         So it is a GROUP BY over the same rows the totals above cover,
         with the same reversal exclusion, and the money follows the same
         rule as everywhere else in this file: fees are known when the
         column is non-null, realized margin is known only for deals a
         disposal priced, and a teller whose deals carry neither has
         `earningsHome: null` rather than a confident nothing. A teller who
         spent the day buying currency genuinely earned no realized margin
         — that is not the same fact as a teller who earned zero.

         `actorId` is the principal the ledger recorded, not a display
         name. Naming is the client's job and it already knows how (see
         personOf in cdos-till.jsx); inventing a directory here would put
         a second staff list on the server. */
      const byActor = await client.query(
        `SELECT t.actor_id AS actor_id,
                count(*)::int AS deals,
                sum(COALESCE(t.fee_amount, t.fee_cad)) AS fees_home,
                sum(t.realized_pnl_home) FILTER (
                  WHERE t.realized_pnl_home IS NOT NULL) AS realized_home,
                count(*) FILTER (
                  WHERE t.realized_pnl_home IS NOT NULL)::int AS priced,
                sum(CASE WHEN t.from_currency = $6 THEN t.input_amount
                         WHEN t.to_currency   = $6 THEN t.output_amount
                         ELSE NULL END) AS volume_home
           FROM ledger_transactions t
           LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
          WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
            AND t.workspace_id=$4 AND t.till_id=$5
            AND r.reversal_id IS NULL
            AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
            AND ($7::timestamptz IS NULL OR t.posted_at >= $7)
            AND ($8::timestamptz IS NULL OR t.posted_at <  $8)
          GROUP BY t.actor_id
          ORDER BY t.actor_id`,
        [...tillScope(actor), home, window.from ?? null, window.to ?? null],
      );

      /* "Which currencies did we make money on" — the question
         docs/COST_BASIS.md says the whole business turns on. Realized P&L
         belongs to the currency that LEFT the desk, because that is the
         stock whose cost was consumed. */
      const byCurrency = await client.query(
        `SELECT t.to_currency AS currency,
                count(*)::int AS deals,
                sum(t.output_amount) AS sold,
                sum(t.realized_pnl_home) FILTER (
                  WHERE t.realized_pnl_home IS NOT NULL) AS realized_home,
                count(*) FILTER (
                  WHERE t.realized_pnl_home IS NOT NULL)::int AS priced
           FROM ledger_transactions t
           LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
          WHERE t.tenant_id=$1 AND t.legal_entity_id=$2 AND t.branch_id=$3
            AND t.workspace_id=$4 AND t.till_id=$5
            AND r.reversal_id IS NULL
            AND t.to_currency <> $6
            AND ($7::timestamptz IS NULL OR t.posted_at >= $7)
            AND ($8::timestamptz IS NULL OR t.posted_at <  $8)
          GROUP BY t.to_currency
          ORDER BY t.to_currency`,
        [...tillScope(actor), home, window.from ?? null, window.to ?? null],
      );
      await client.query("COMMIT");

      const posted = Number(row.posted);
      const fees = row.fees_home == null ? null : money(row.fees_home);
      const realized = row.realized_home == null ? null : money(row.realized_home);
      return {
        homeCurrency: home,
        tillId: actor.tillId,
        from: window.from ?? null,
        to: window.to ?? null,
        /* The counts are always real numbers — "no deals" is something the
           ledger genuinely knows. The MONEY is null when there is nothing
           to total, so a screen cannot render an empty period as a
           confident $0.00 beside a busy one. */
        posted,
        reversed: Number(row.reversed),
        volumeHome: row.volume_home == null ? null : money(row.volume_home),
        /* Deals in the window whose size this book cannot state in home
           currency — a foreign-to-foreign cross. Shown, not hidden: a
           volume figure that silently omits deals is worse than one that
           says how many it omitted. */
        unvaluedDeals: Number(row.unvalued),
        feesHome: fees,
        /* What the desk EARNED, from the figure `dispose()` wrote at the
           moment of the sale. A purchase realizes nothing and carries
           null, so a day of nothing but buying reports no profit rather
           than a profit of zero. */
        realizedPnlHome: realized,
        costOfSaleHome:
          row.cost_of_sale_home == null ? null : money(row.cost_of_sale_home),
        /* Fees are revenue and realized P&L is margin; the desk's take is
           both, and it is null unless at least one of them exists. */
        earningsHome:
          fees === null && realized === null
            ? null
            : money(new Decimal(fees ?? 0).add(realized ?? 0)),
        /* How many of the posted deals carry a cost basis. Below `posted`,
           somebody is looking at a partial earnings figure and deserves to
           be told so on the screen rather than in a support ticket. */
        pricedDeals: Number(row.priced),
        firstPostedAt: row.first_at ? new Date(row.first_at).toISOString() : null,
        lastPostedAt: row.last_at ? new Date(row.last_at).toISOString() : null,
        byActor: byActor.rows.map((item) => {
          const actorFees = item.fees_home == null ? null : money(item.fees_home);
          const actorRealized =
            item.realized_home == null ? null : money(item.realized_home);
          return {
            actorId: String(item.actor_id),
            deals: Number(item.deals),
            volumeHome: item.volume_home == null ? null : money(item.volume_home),
            feesHome: actorFees,
            realizedPnlHome: actorRealized,
            earningsHome:
              actorFees === null && actorRealized === null
                ? null
                : money(new Decimal(actorFees ?? 0).add(actorRealized ?? 0)),
            pricedDeals: Number(item.priced),
          };
        }),
        byCurrency: byCurrency.rows.map((item) => ({
          currency: String(item.currency).trim(),
          deals: Number(item.deals),
          sold: money(item.sold ?? 0),
          realizedPnlHome:
            item.realized_home == null ? null : money(item.realized_home),
          pricedDeals: Number(item.priced),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * What this branch is holding, and what it cost.
   *
   * The drawer and the strong room are read as two separate boxes and
   * reported as two, because they carry separate averages and a float
   * between them is a real movement of specific cash. The totals are the
   * sum of what is actually there.
   *
   * `unrealizedPnlHome` is market value minus cost basis, and it is null
   * unless BOTH are known for the WHOLE quantity. The Vault used to show
   * "+$4,813.65 unrealized" over currencies whose `avg_cost` is NULL on
   * this server — a P&L tile presenting an invented basis as fact, which
   * is the single most expensive kind of wrong a treasury screen can be.
   */
  async position(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const home = (await resolvePack(client, actor.legalEntityId)).homeCurrency;

      const till = await client.query(
        `SELECT currency,available_amount,avg_cost
           FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
          ORDER BY currency`,
        tillScope(actor),
      );
      const vault = await client.query(
        `SELECT currency,available_amount,avg_cost
           FROM ledger_vault_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          ORDER BY currency`,
        [actor.tenantId, actor.legalEntityId, actor.branchId],
      );
      /* The desk's own published board — the only price on this server
         anybody stood behind. `units_per_cad` is what it says, so the home
         value of one unit is its reciprocal, and ONLY while the home
         currency is the Canadian dollar: a rate quoted against somebody
         else's money is not a valuation. A London entity gets nulls here
         and its screens say the market value is unknown, which is true.
         Same reasoning as boardUnitCostHome in vault-control.ts. */
      const rates = await client.query(
        `SELECT DISTINCT ON (currency) currency,units_per_cad
           FROM ledger_rates
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          ORDER BY currency,workspace_id`,
        [actor.tenantId, actor.legalEntityId, actor.branchId],
      );
      await client.query("COMMIT");

      type Box = { quantity: Decimal; avgCost: Decimal | null };
      const boxes = new Map<string, { till: Box | null; vault: Box | null }>();
      const put = (
        side: "till" | "vault",
        rows: { currency: string; available_amount: string; avg_cost: string | null }[],
      ) => {
        for (const item of rows) {
          const currency = String(item.currency).trim();
          const entry = boxes.get(currency) ?? { till: null, vault: null };
          entry[side] = {
            quantity: new Decimal(item.available_amount),
            avgCost: item.avg_cost == null ? null : new Decimal(item.avg_cost),
          };
          boxes.set(currency, entry);
        }
      };
      put("till", till.rows);
      put("vault", vault.rows);

      const unitHome = new Map<string, Decimal>();
      if (home === "CAD") {
        for (const item of rates.rows) {
          const perCad = new Decimal(item.units_per_cad);
          if (perCad.gt(0)) {
            unitHome.set(String(item.currency).trim(), new Decimal(1).div(perCad));
          }
        }
      }

      /* One box, valued. Done here rather than on the screen so the rule
         about what may be shown lives in exactly one place: the Vault
         wants the safe's own figures, the Cash Drawer wants the drawer's,
         and if each of them multiplied a quantity by an average for
         itself there would be three answers to "what is the basis" again. */
      const value = (box: Box | null, isHome: boolean, unit: Decimal | null) => {
        if (!box) return null;
        /* How much of this box the ledger cannot price. A positive balance
           with no average has none of it priced; the home currency is
           priced at one by definition. The basis is reported only when
           that figure is nil, because a total silently covering three
           quarters of the stock is exactly the figure that got shown as
           fact. */
        const unpriced =
          !isHome && box.avgCost === null && box.quantity.gt(0)
            ? box.quantity
            : new Decimal(0);
        const basis = isHome
          ? box.quantity
          : unpriced.gt(0)
            ? null
            : box.quantity.mul(box.avgCost ?? 0);
        const marketValue = unit === null ? null : box.quantity.mul(unit);
        return {
          quantity: money(box.quantity),
          avgCost:
            isHome || box.avgCost === null
              ? null
              : box.avgCost.toFixed(COST_PLACES),
          unpricedQuantity: money(unpriced),
          costBasisHome: basis === null ? null : money(basis),
          marketValueHome: marketValue === null ? null : money(marketValue),
          unrealizedPnlHome:
            isHome || basis === null || marketValue === null
              ? null
              : money(marketValue.minus(basis)),
        };
      };

      const currencies = [...boxes.keys()].sort().map((currency) => {
        const entry = boxes.get(currency)!;
        const sides = [entry.till, entry.vault].filter(Boolean) as Box[];
        const quantity = sides.reduce(
          (total, box) => total.add(box.quantity),
          new Decimal(0),
        );
        /* The home currency's cost is one by definition — it is the unit
           everything else is measured in — so it never carries an average
           and never shows an unrealized gain against itself. */
        const isHome = currency === home;
        const unpriced = sides.reduce(
          (total, box) =>
            !isHome && box.avgCost === null && box.quantity.gt(0)
              ? total.add(box.quantity)
              : total,
          new Decimal(0),
        );
        const basis = isHome
          ? quantity
          : unpriced.gt(0)
            ? null
            : sides.reduce(
                (total, box) =>
                  total.add(box.quantity.mul(box.avgCost ?? 0)),
                new Decimal(0),
              );
        const unit = isHome ? new Decimal(1) : (unitHome.get(currency) ?? null);
        const marketValue = unit === null ? null : quantity.mul(unit);
        return {
          currency,
          quantity: money(quantity),
          till: value(entry.till, isHome, unit),
          vault: value(entry.vault, isHome, unit),
          unpricedQuantity: money(unpriced),
          costBasisHome: basis === null ? null : money(basis),
          marketUnitHome: unit === null ? null : unit.toFixed(COST_PLACES),
          marketValueHome: marketValue === null ? null : money(marketValue),
          unrealizedPnlHome:
            isHome || basis === null || marketValue === null
              ? null
              : money(marketValue.minus(basis)),
        };
      });

      const knownValue = currencies.filter((item) => item.marketValueHome !== null);
      const knownBasis = currencies.filter((item) => item.costBasisHome !== null);
      /* A box's own headline. Same rule as the branch total below: a sum
         is only offered when every row it covers has a figure, so the
         Vault's "Total on hand" cannot quietly omit the two currencies
         whose rate the branch has never published. */
      const boxTotals = (side: "till" | "vault") => {
        const held = currencies
          .map((item) => item[side])
          .filter(Boolean) as NonNullable<(typeof currencies)[number]["till"]>[];
        const sum = (
          pick: (row: (typeof held)[number]) => string | null,
        ) =>
          held.length && held.every((row) => pick(row) !== null)
            ? money(
                held.reduce((total, row) => total.add(pick(row)!), new Decimal(0)),
              )
            : null;
        return {
          currencies: held.length,
          marketValueHome: sum((row) => row.marketValueHome),
          costBasisHome: sum((row) => row.costBasisHome),
          unrealizedPnlHome:
            held.length &&
            held.every(
              (row) =>
                row.marketValueHome !== null && row.costBasisHome !== null,
            )
              ? money(
                  held.reduce(
                    (total, row) =>
                      total
                        .add(row.marketValueHome!)
                        .minus(row.costBasisHome!),
                    new Decimal(0),
                  ),
                )
              : null,
        };
      };
      return {
        homeCurrency: home,
        branchId: actor.branchId,
        tillId: actor.tillId,
        /* "Tracked" is the difference between a box that holds nothing and
           a box nobody has told the ledger about. They are not the same
           state and must never render the same. */
        tillTracked: till.rows.length > 0,
        vaultTracked: vault.rows.length > 0,
        currencies,
        tillTotals: boxTotals("till"),
        vaultTotals: boxTotals("vault"),
        /* A total is only a total if it covers everything. Where any held
           currency has no market value, the sum of the rest is not "the
           value of the desk's cash" and is not offered as one. */
        marketValueHome:
          knownValue.length === currencies.length && currencies.length
            ? money(
                currencies.reduce(
                  (total, item) => total.add(item.marketValueHome!),
                  new Decimal(0),
                ),
              )
            : null,
        costBasisHome:
          knownBasis.length === currencies.length && currencies.length
            ? money(
                currencies.reduce(
                  (total, item) => total.add(item.costBasisHome!),
                  new Decimal(0),
                ),
              )
            : null,
        /* Which currencies the totals above would have had to guess at.
           Named rather than counted, so the screen can say WHICH row is
           the reason the headline reads "—". */
        unvaluedCurrencies: currencies
          .filter((item) => item.marketValueHome === null)
          .map((item) => item.currency),
        unpricedCurrencies: currencies
          .filter((item) => item.costBasisHome === null)
          .map((item) => item.currency),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The rules this desk trades under, as the book holds them.
   *
   * The browser has been carrying `const THRESHOLD = 10000` in Canadian
   * dollars since the first commit, and flagging reportable deals at that
   * number on two screens while Compliance flagged at the owner's setting
   * on three others — the same desk, two different lines. There is one
   * answer to "what is the reporting threshold here", it belongs to the
   * jurisdiction pack, and this is where a client asks for it.
   */
  async jurisdiction(actor: LedgerActor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const pack = await resolvePack(client, actor.legalEntityId);
      /* THE FORMS THIS DESK HAS TO FILE, AND WHERE THEY GO.
         `jurisdiction_reports` has carried this since migration 012 and
         nothing served it, so the filing worksheet went on printing "FWR"
         — the name of Canada's portal — as the place a Dubai desk pastes
         its goAML report, and "7-digit FINTRAC ID" as the hint on a field
         a London desk fills with something else entirely.
         `filingFormat` is the regulator's own words for how the completed
         report is submitted, and it is null when the pack does not say. A
         screen with no filing format names no portal; naming the wrong
         country's is how this went wrong. Highest version of each code
         wins, for the same reason report-filings.ts resolves that way: a
         revised form is a new version, not a restatement. */
      const reports = await client.query(
        `SELECT DISTINCT ON (code)
                code, name, kind, trigger_threshold, trigger_currency,
                aggregation_hours, filing_format, fields, format_rules, version
           FROM jurisdiction_reports
          WHERE pack_id=$1
          ORDER BY code, version DESC`,
        [pack.packId],
      );
      await client.query("COMMIT");
      return {
        pack,
        reports: reports.rows.map((row) => ({
          code: String(row.code),
          name: String(row.name),
          kind: String(row.kind),
          triggerThreshold:
            row.trigger_threshold == null ? null : money(row.trigger_threshold),
          triggerCurrency:
            row.trigger_currency == null
              ? null
              : String(row.trigger_currency).trim().toUpperCase(),
          aggregationHours:
            row.aggregation_hours == null ? null : Number(row.aggregation_hours),
          filingFormat: row.filing_format == null ? null : String(row.filing_format),
          /* Seeded EMPTY on purpose for every pack — migration 012 says
             why, and it is worth restating where a client can see it: a
             transcribed form is somebody else's paperwork and a guessed
             one looks official while being wrong. An empty list means
             "not transcribed yet", and a screen must render that as a
             gap rather than as a form with no fields. */
          fields: Array.isArray(row.fields) ? row.fields : [],
          formatRules:
            row.format_rules && typeof row.format_rules === "object"
              ? row.format_rules
              : {},
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
