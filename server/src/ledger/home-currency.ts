/* ============================================================
   Moving the currency the books are kept in.

   The browser used to do this itself: a dropdown in Settings rewrote
   `baseCurrency` and multiplied the thresholds by a float. The ledger
   never heard about it, so the till, the tape and a second browser
   kept the old currency, and the numbers on the screen were a guess.

   The book is `legal_entities.home_currency`. Changing it is the
   owner's act, confirmed with the password they sign in with, and
   only while every till is closed and every cash count has been
   closed out. A market snapshot from the last 24 hours has to be
   able to price the move. The rate and the time it was fetched are
   written on the audit row.

   What moves:
     the book currency
     the desk's own money lines, restated at that rate, once
     the pack's lines, the next time they are read (they stay
       written in the currency the pack was authored in)

   What does not move:
     any row already on the ledger. `ledger_transactions` is
       append-only. This file never updates it.
     cash sitting in a till or a vault. It stays the currency it is.
     a published rate board. Its mids were quoted in the old home.
       They are labelled with that currency and stop being the live
       board until somebody publishes again.

   See server/src/compliance/sanctioned-currencies.ts for the list
   of currencies that must not be selectable. This file calls that
   hook. It does not keep a list of its own.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { isSanctionedCurrency } from "../compliance/sanctioned-currencies.js";
import { INDICATIVE_PER_CAD } from "../rates/starting-board.js";
import { verifyPassword } from "../auth/password.js";
import { homePerUnit, roundDownCents } from "./compliance-gate.js";
import { asCurrencyCode, carriable } from "./currencies.js";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { LedgerError, type LedgerActor } from "./service.js";

export type HomeCurrencyView = {
  currency: string;
  /** Codes the picker may offer. Sanctioned ones are not in this list. */
  choices: string[];
  /** Codes the sanctions hook refused. Empty until that lookup is installed. */
  blocked: string[];
  owner: boolean;
  /** Set when the live board was quoted in some other currency. */
  rateBoardNotice: string | null;
};

export type HomeCurrencyPreview = HomeCurrencyView & {
  next: string;
  /** New-home units per 1 old-home unit, 12 decimal places. Null when no fresh rate can say. */
  rate: string | null;
  /** When the snapshot was fetched. Null when no snapshot was used. */
  rateAt: string | null;
  /** Plain sentences. Empty when the move cannot be priced. */
  willChange: string[];
  willNotChange: string[];
  /** Why the move cannot be saved. Empty when it can. */
  blockers: string[];
};

export type HomeCurrencyResult = {
  currency: string;
  previous: string;
  rate: string;
  rateAt: string;
  rateBoardNotice: string;
};

type Snapshot = {
  id: string;
  mids: Record<string, unknown>;
  fetchedAt: Date;
  fresh: boolean;
};

const OWNER_ONLY = "Only the owner can change the base currency.";

function codeOf(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/** Plain sentence when a published board is still quoted in another currency. */
export function rateBoardCurrencyNotice(quoted: string, book: string): string | null {
  if (!quoted || !book || quoted === book) return null;
  return (
    `The rate board was priced in ${quoted}. Publish it again in ${book} ` +
    `before anyone quotes from it. Those prices are not in ${book}.`
  );
}

async function ownerOrThrow(client: pg.PoolClient, actor: LedgerActor): Promise<void> {
  try {
    await authorizeLedgerActor(client, actor, "compliance:thresholds");
  } catch (error) {
    if (error instanceof LedgerError && error.code === "AUTHORIZATION_DENIED") {
      throw new LedgerError("AUTHORIZATION_DENIED", OWNER_ONLY);
    }
    throw error;
  }
}

async function bookCurrency(client: pg.PoolClient, legalEntityId: string): Promise<string> {
  const pack = await resolvePack(client, legalEntityId);
  const home = codeOf(pack.homeCurrency);
  if (!/^[A-Z]{3}$/.test(home)) {
    throw new LedgerError(
      "INVALID_REQUEST",
      "This desk has no base currency on the ledger, so it cannot be changed from here.",
    );
  }
  return home;
}

async function newestSnapshot(client: pg.PoolClient): Promise<Snapshot | null> {
  try {
    const found = await client.query(
      `SELECT id, mids, fetched_at,
              (fetched_at >= now() - interval '24 hours') AS fresh
         FROM market_rates
        ORDER BY fetched_at DESC
        LIMIT 1`,
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      mids: (row.mids ?? {}) as Record<string, unknown>,
      fetchedAt: new Date(row.fetched_at),
      fresh: row.fresh === true,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return null;
    throw error;
  }
}

/* New-home units per 1 old-home unit, from a CAD-per-unit snapshot.
   CAD itself is 1 and is not stored on the snapshot. */
function crossRate(mids: Record<string, unknown>, from: string, to: string): Decimal | null {
  return homePerUnit(mids, from, to);
}

type OpenTill = { tillId: string; counted: boolean };

async function openTills(client: pg.PoolClient, actor: LedgerActor): Promise<OpenTill[]> {
  const found = await client.query(
    `SELECT s.till_id,
            EXISTS (
              SELECT 1 FROM ledger_till_count_batches b
               WHERE b.session_id = s.session_id
                 AND b.count_kind <> 'close'
            ) AS counted
       FROM ledger_till_sessions s
      WHERE s.tenant_id = $1 AND s.legal_entity_id = $2 AND s.status = 'open'
      ORDER BY s.branch_id, s.till_id`,
    [actor.tenantId, actor.legalEntityId],
  );
  return found.rows.map((row) => ({
    tillId: String(row.till_id),
    counted: row.counted === true,
  }));
}

function tillBlocker(open: OpenTill[]): string | null {
  if (!open.length) return null;
  const counted = open.filter((row) => row.counted).map((row) => row.tillId);
  const plain = open.filter((row) => !row.counted).map((row) => row.tillId);
  const parts: string[] = [];
  if (plain.length) {
    parts.push(
      plain.length === 1
        ? `Till ${plain[0]} is still open.`
        : `Tills ${plain.join(", ")} are still open.`,
    );
  }
  if (counted.length) {
    parts.push(
      counted.length === 1
        ? `A cash count on till ${counted[0]} has not been closed out.`
        : `Cash counts on tills ${counted.join(", ")} have not been closed out.`,
    );
  }
  parts.push("Close every till and finish every cash count before changing the base currency.");
  return parts.join(" ");
}

async function picker(current: string): Promise<{ choices: string[]; blocked: string[] }> {
  const codes = ["CAD", ...Object.keys(INDICATIVE_PER_CAD)]
    .map((code) => codeOf(code))
    .filter((code, index, all) => /^[A-Z]{3}$/.test(code) && all.indexOf(code) === index && code !== current);
  const choices: string[] = [];
  const blocked: string[] = [];
  for (const code of codes) {
    if (!carriable(code).ok) continue;
    if (await isSanctionedCurrency(code)) blocked.push(code);
    else choices.push(code);
  }
  choices.sort();
  blocked.sort();
  return { choices, blocked };
}

async function liveBoardNotice(client: pg.PoolClient, actor: LedgerActor, book: string): Promise<string | null> {
  const boards = await client.query(
    `SELECT DISTINCT ON (branch_id) home_currency
       FROM rate_boards
      WHERE tenant_id = $1 AND legal_entity_id = $2
      ORDER BY branch_id, published_at DESC`,
    [actor.tenantId, actor.legalEntityId],
  );
  for (const row of boards.rows) {
    const notice = rateBoardCurrencyNotice(codeOf(row.home_currency), book);
    if (notice) return notice;
  }
  return null;
}

function willChangeSentences(current: string, next: string, rate: string, rateAt: string): string[] {
  return [
    `The desk keeps its books in ${next} from the moment this is saved.`,
    `Reporting and identification lines written in another currency are converted into ${next} at ${rate} ${next} per 1 ${current}. That market rate was fetched at ${rateAt}.`,
    `The rate tape and Transfers use ${next}.`,
    `The published rate board was priced in ${current}. It comes off the counter until you publish it again in ${next}.`,
  ];
}

function willNotChangeSentences(): string[] {
  return [
    "Deals already on the ledger keep the currency they were posted in. Nothing already written is rewritten.",
    "Cash sitting in a till or a vault stays in the currency it is. This does not move it and does not convert it.",
    "Record retention and the aggregation window are not amounts, so they stay as they are.",
    "The currencies this desk already deals in stay available, including the previous base currency.",
  ];
}

async function readPasswordHash(client: pg.PoolClient, actor: LedgerActor): Promise<string> {
  const found = await client.query(
    "SELECT password_hash FROM staff_users WHERE id = $1 AND tenant_id = $2",
    [actor.userId, actor.tenantId],
  );
  return String(found.rows[0]?.password_hash ?? "");
}

function restate(amount: unknown, rate: Decimal): string {
  const parsed = new Decimal(String(amount));
  const next = roundDownCents(parsed.mul(rate));
  if (!next.isFinite() || !next.gt(0)) {
    throw new LedgerError(
      "INVALID_REQUEST",
      "That rate would turn a threshold into nothing. The base currency was not changed.",
    );
  }
  return next.toFixed(2);
}

export class HomeCurrencyService {
  constructor(private readonly pool: pg.Pool) {}

  async view(actor: LedgerActor): Promise<HomeCurrencyView> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const currency = await bookCurrency(client, actor.legalEntityId);
      const listed = await picker(currency);
      const notice = await liveBoardNotice(client, actor, currency);
      await client.query("COMMIT");
      return {
        currency,
        choices: listed.choices,
        blocked: listed.blocked,
        owner: actor.role === "administrator",
        rateBoardNotice: notice,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async preview(actor: LedgerActor, nextRaw: string): Promise<HomeCurrencyPreview> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ownerOrThrow(client, actor);
      const current = await bookCurrency(client, actor.legalEntityId);
      const listed = await picker(current);
      const notice = await liveBoardNotice(client, actor, current);
      const assessed = await this.assess(client, actor, current, nextRaw);
      await client.query("COMMIT");
      return {
        currency: current,
        next: assessed.next,
        choices: listed.choices,
        blocked: listed.blocked,
        owner: true,
        rate: assessed.rate?.toDecimalPlaces(12).toFixed(12) ?? null,
        rateAt: assessed.rateAt,
        willChange: assessed.willChange,
        willNotChange: willNotChangeSentences(),
        blockers: assessed.blockers,
        rateBoardNotice: assessed.rate
          ? rateBoardCurrencyNotice(current, assessed.next)
          : notice,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async change(actor: LedgerActor, nextRaw: string, password: string): Promise<HomeCurrencyResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ownerOrThrow(client, actor);
      const hash = await readPasswordHash(client, actor);
      const passwordOk = hash ? await verifyPassword(password, hash) : false;
      if (!passwordOk) {
        throw new LedgerError(
          "PASSWORD_REJECTED",
          "That password does not match. The base currency was not changed.",
        );
      }

      const locked = await client.query(
        "SELECT report_threshold, id_threshold, traded_currencies FROM legal_entities WHERE id = $1 FOR UPDATE",
        [actor.legalEntityId],
      );
      if (!locked.rowCount) {
        throw new LedgerError(
          "LEGAL_ENTITY_NOT_FOUND",
          "This desk's legal entity is not on the ledger, so its base currency cannot be changed.",
        );
      }
      const current = await bookCurrency(client, actor.legalEntityId);
      const assessed = await this.assess(client, actor, current, nextRaw);
      if (assessed.blockers.length || !assessed.rate || !assessed.snapshot) {
        throw new LedgerError(
          assessed.blockerCode,
          assessed.blockers[0] ?? "The base currency was not changed.",
        );
      }
      const next = assessed.next;
      const rate = assessed.rate;
      const row = locked.rows[0];

      const report = row.report_threshold == null ? null : restate(row.report_threshold, rate);
      const identify = row.id_threshold == null ? null : restate(row.id_threshold, rate);
      const traded = shiftedSet(row.traded_currencies, current, next);

      /* Label any board that was never told which currency it is in.
         The mids are not touched. After the book moves, a board still
         labelled with the old currency stops being the live one. */
      await client.query(
        `UPDATE rate_boards
            SET home_currency = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2
            AND (home_currency IS NULL OR btrim(home_currency::text) = '')`,
        [actor.tenantId, actor.legalEntityId, current],
      );
      await client.query(
        `UPDATE legal_entities
            SET home_currency = $2,
                report_threshold = $3,
                id_threshold = $4,
                traded_currencies = $5
          WHERE id = $1`,
        [actor.legalEntityId, next, report, identify, traded],
      );
      await client.query(
        `UPDATE tenants
            SET setup = jsonb_set(COALESCE(setup, '{}'::jsonb), '{homeCurrency}', to_jsonb($2::text), true)
          WHERE id = $1`,
        [actor.tenantId, next],
      );

      const rateText = rate.toDecimalPlaces(12).toFixed(12);
      const rateAt = assessed.snapshot.fetchedAt.toISOString();
      await client.query(
        `INSERT INTO ledger_audit_events
          (event_id, tenant_id, legal_entity_id, branch_id, workspace_id, actor_id,
           action, target_id, reason, correlation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'desk.home_currency.change',$7,$8,$9,now())`,
        [
          randomUUID(),
          actor.tenantId,
          actor.legalEntityId,
          actor.branchId,
          actor.workspaceId,
          actor.userId,
          actor.legalEntityId,
          `home currency ${current} to ${next}; rate ${rateText} ${next} per 1 ${current}; market rate fetched at ${rateAt}; snapshot ${assessed.snapshot.id}`,
          randomUUID(),
        ],
      );
      await client.query("COMMIT");
      return {
        currency: next,
        previous: current,
        rate: rateText,
        rateAt,
        rateBoardNotice: rateBoardCurrencyNotice(current, next) ?? "",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async assess(
    client: pg.PoolClient,
    actor: LedgerActor,
    current: string,
    nextRaw: string,
  ): Promise<{
    next: string;
    rate: Decimal | null;
    rateAt: string | null;
    snapshot: Snapshot | null;
    willChange: string[];
    blockers: string[];
    blockerCode: string;
  }> {
    const next = asCurrencyCode(nextRaw) ?? "";
    const blockers: string[] = [];
    let blockerCode = "INVALID_REQUEST";
    if (!next) {
      blockers.push("A base currency is a three letter code.");
    } else if (next === current) {
      blockers.push(`The books are already kept in ${current}.`);
    } else if (await isSanctionedCurrency(next)) {
      blockerCode = "CURRENCY_SANCTIONED";
      blockers.push("Currencies of sanctioned countries cannot be selected.");
    } else {
      const carried = carriable(next);
      if (!carried.ok) blockers.push(carried.reason);
    }

    const tills = await openTills(client, actor);
    const tillMessage = tillBlocker(tills);
    if (tillMessage) {
      if (!blockers.length) blockerCode = "TILL_NOT_CLOSED";
      blockers.push(tillMessage);
    }

    let rate: Decimal | null = null;
    let snapshot: Snapshot | null = null;
    if (next && next !== current && !blockers.some((line) => line.startsWith("Currencies of sanctioned"))) {
      snapshot = await newestSnapshot(client);
      if (!snapshot || !snapshot.fresh) {
        if (!blockers.length) blockerCode = "HOME_RATE_UNAVAILABLE";
        blockers.push(
          `There is no market rate for ${next} from the last 24 hours, so the lines cannot be converted. Nothing was changed.`,
        );
      } else {
        rate = crossRate(snapshot.mids, current, next);
        if (!rate) {
          if (!blockers.length) blockerCode = "HOME_RATE_UNAVAILABLE";
          blockers.push(
            `The latest market rate does not include ${next}, so the lines cannot be converted. Nothing was changed.`,
          );
        }
      }
    }

    const rateText = rate ? rate.toDecimalPlaces(12).toFixed(12) : null;
    const rateAt = snapshot && rate ? snapshot.fetchedAt.toISOString() : null;
    return {
      next: next || nextRaw,
      rate,
      rateAt,
      snapshot: rate ? snapshot : null,
      willChange: rateText && rateAt ? willChangeSentences(current, next, rateText, rateAt) : [],
      blockers,
      blockerCode,
    };
  }
}

/* The stated set does not include the home currency: the resolver adds
   it. After the move, the old home is a foreign currency the desk can
   still deal in, and the new home is no longer one of the foreign ones. */
function shiftedSet(stored: unknown, previous: string, next: string): string[] | null {
  if (!Array.isArray(stored)) return null;
  const codes = stored
    .map((code) => asCurrencyCode(code))
    .filter((code): code is string => !!code && code !== next);
  if (!codes.includes(previous)) codes.push(previous);
  const unique = Array.from(new Set(codes)).sort();
  return unique.length ? unique : null;
}
