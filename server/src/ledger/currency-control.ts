/* ============================================================
   Reading and changing the currencies a desk deals in.

   Separate from currencies.ts for the same reason threshold-control.ts is
   separate from thresholds.ts: this half needs the actor, the permission
   table and the audit log, and the posting path has to be able to resolve
   a desk's set without dragging any of that into a money transaction.

   ---- WHY THIS IS AUDITED ----

   Narrowing the set is a refusal a teller will meet at the counter with a
   customer in front of them, and the message names the set rather than
   the person who chose it. Widening it is the more consequential
   direction: the desk starts holding an inventory it did not hold
   yesterday, and every downstream figure — the vault's cost basis, the
   exposure panel, the day's close — has a new currency in it from that
   moment. Neither leaves a trace anywhere else in the book. `traded
   _currencies` is one column that gets overwritten; without a row here
   there is no answer to "when did we start taking pesos, and who said
   so".

   ---- WHY IT IS THE OWNER'S ----

   `compliance:thresholds` is reused deliberately rather than a new
   permission being invented. It is administrator-only and it is already
   the answer to "who gets to change what this desk will and will not
   do". A second permission with the same holder is a second thing to
   get out of step. If the day comes that these need to diverge, the day
   to split them is the day somebody wants a different holder — not
   today, on the strength of a guess.
   ============================================================ */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { resolvePack } from "./jurisdiction.js";
import { LedgerError, type LedgerActor } from "./service.js";
import {
  asCurrencyCode,
  carriable,
  minorUnits,
  resolveDeskCurrencies,
  type DeskCurrencies,
} from "./currencies.js";

export type DeskCurrencyView = DeskCurrencies & {
  /** minor units for anything that is not the ordinary two */
  minorUnits: Record<string, number>;
};

const withUnits = (desk: DeskCurrencies): DeskCurrencyView => ({
  ...desk,
  minorUnits: Object.fromEntries(
    Array.from(new Set([...(desk.stated ?? []), ...desk.suggested]))
      .map((code) => [code, minorUnits(code)] as const)
      .filter(([, places]) => places !== 2),
  ),
});

export class CurrencyService {
  constructor(private readonly pool: pg.Pool) {}

  async current(actor: LedgerActor): Promise<DeskCurrencyView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const pack = await resolvePack(client, actor.legalEntityId);
      const desk = await resolveDeskCurrencies(client, {
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        homeCurrency: pack.homeCurrency,
      });
      await client.query("COMMIT");
      return withUnits(desk);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * State the desk's currencies, or hand the question back with a null.
   *
   * Null is not an empty set. It restores "nobody has stated one", which
   * leaves the desk able to deal in anything the ledger can carry — the
   * state every desk is in until somebody decides otherwise, and the
   * reason removing the old four-currency enum did not simply install a
   * smaller ceiling.
   *
   * Nothing already on the book is disturbed. Cash in a currency that has
   * just been dropped from the set stays exactly where it is, stays
   * countable, and stays closeable; what changes is whether more of it
   * can be brought in. Sweeping it out would be inventing a movement of
   * somebody's money to make a settings change tidy.
   */
  async set(
    actor: LedgerActor,
    codes: readonly string[] | null,
  ): Promise<DeskCurrencyView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "compliance:thresholds");
      const pack = await resolvePack(client, actor.legalEntityId);
      const home = pack.homeCurrency;

      let stored: string[] | null = null;
      if (codes !== null) {
        const seen: string[] = [];
        for (const raw of codes) {
          const code = asCurrencyCode(raw);
          if (!code)
            throw new LedgerError(
              "INVALID_REQUEST",
              `"${raw}" is not a currency code.`,
            );
          /* Refused rather than silently dropped. Somebody typing KWD
             into this box has to be told the ledger cannot hold it —
             finding out later, from a teller who cannot take a dinar, is
             the version of this that wastes a day. */
          const carried = carriable(code);
          if (!carried.ok)
            throw new LedgerError("UNSUPPORTED_CURRENCY", carried.reason);
          if (code !== home && !seen.includes(code)) seen.push(code);
        }
        if (!seen.length)
          throw new LedgerError(
            "INVALID_REQUEST",
            `Name at least one currency besides ${home}, or clear the setting to trade any currency the ledger carries.`,
          );
        stored = seen.sort();
      }

      const before = await resolveDeskCurrencies(client, {
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        homeCurrency: home,
      });
      const updated = await client.query(
        "UPDATE legal_entities SET traded_currencies=$2 WHERE id=$1",
        [actor.legalEntityId, stored],
      );
      if (!updated.rowCount)
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its currencies cannot be set here.",
        );
      const after = await resolveDeskCurrencies(client, {
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        homeCurrency: home,
      });

      /* The row a person reads later. Both sides spelled out, and the
         currencies still SITTING IN THE DRAWERS that the desk has just
         stopped trading named explicitly — that is the fact somebody
         will be looking for, and it is not derivable from the two sets
         alone. */
      const held = await client.query(
        `SELECT DISTINCT currency FROM ledger_till_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND available_amount <> 0
          UNION
         SELECT DISTINCT currency FROM ledger_vault_balances
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND available_amount <> 0`,
        [actor.tenantId, actor.legalEntityId, actor.branchId],
      );
      const stranded = after.stated
        ? held.rows
            .map((row) => String(row.currency))
            .filter((code) => !after.stated!.includes(code))
            .sort()
        : [];
      const say = (desk: DeskCurrencies) =>
        desk.stated ? desk.stated.join(", ") : "any the ledger carries";
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,
           action,target_id,reason,correlation_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'desk.currencies.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          `currencies ${say(before)} → ${say(after)}` +
            (stranded.length
              ? `; still holding ${stranded.join(", ")} in this branch's drawers`
              : ""),
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
      return withUnits(after);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
