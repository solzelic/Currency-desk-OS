/* ============================================================
   Sign-up v2.1, the front door: the CurrencyDesk ID (SIGNUP-LOGIC §2).

     GET  /api/onboarding/:id/state   → { valid, operatingName, state }
     POST /api/onboarding/resend-id   → 202, always

   THE ID IDENTIFIES; IT DOES NOT AUTHENTICATE. Typed alone it finds the
   reservation and gives back the shop's operating name, and nothing else:
   no owner name, email, mobile or country until the email code passes
   (§2.1, §7). The credential, the code and the PIN are what open the desk.

   Misses are counted per ID and per connection (§2.2): 10 in 15 minutes
   closes that ID, and that connection, for 15 minutes. A closed ID stays
   closed even when it is typed correctly, which is the point of counting
   per ID; "Send it again" keeps working, so nobody is locked out for good.

   A lost ID is only ever sent to the email on file. The answer is 202
   whether the email has a desk or not, and the work happens after the
   reply, so neither the words nor the timing say which (§2.1).

   Logs carry the ID's last four characters and a hash of the email,
   never the whole of either (standards §6, build doc §9.8).
   ============================================================ */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { sendEmail } from "../email.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";

export const MISS_LIMIT = 10;
export const MISS_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
export const RESEND_PER_EMAIL = 3;
export const RESEND_PER_CONNECTION = 10;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

/** The ID as logs may carry it: its last four characters. */
export const idTail = (id: string): string => `…${id.slice(-4)}`;
/** An email as logs may carry it. Lower-cased first, so one person is one hash. */
export const emailHash = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);

/* The most keys one throttle remembers. Past it, the key seen longest ago
   is forgotten. A flood of new keys pushes out its own oldest keys and never
   refuses anyone else's. A full table that refused every key let one crowd
   of made-up IDs lock every applicant out. */
export const THROTTLE_KEYS = 10_000;

type Seen = { times: number[]; lockedUntil?: number };

/* A sliding count of events per key, with a lock once the count is reached.
   The clock is passed in so tests are deterministic (standards §7.3). */
export class Throttle {
  /* In the order keys were last seen: a Map iterates in insertion order,
     and seeing a key inserts it again. */
  private seen = new Map<string, Seen>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  locked(key: string): boolean {
    const entry = this.seen.get(key);
    if (entry?.lockedUntil === undefined) return false;
    /* Asking counts as being seen, so a key that keeps knocking while
       locked stays locked however many others pass. */
    if (this.now() < entry.lockedUntil) { this.remember(key, entry); return true; }
    this.seen.delete(key);
    return false;
  }

  /** Count one event. True when this event reached the limit. */
  hit(key: string): boolean {
    const t = this.now();
    const entry = this.recent(key, t);
    entry.times.push(t);
    if (entry.times.length < this.max) return false;
    entry.lockedUntil = t + this.lockMs;
    return true;
  }

  /** Room for one more, counting it if there is. */
  take(key: string): boolean {
    if (this.locked(key)) return false;
    const t = this.now();
    const entry = this.recent(key, t);
    if (entry.times.length >= this.max) return false;
    entry.times.push(t);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  /* The key's entry with only the times inside the window, seen now. */
  private recent(key: string, t: number): Seen {
    const entry = this.seen.get(key) ?? { times: [] };
    entry.times = entry.times.filter((at) => t - at < this.windowMs);
    this.remember(key, entry);
    return entry;
  }

  private remember(key: string, entry: Seen): void {
    this.seen.delete(key);
    this.seen.set(key, entry);
    for (const oldest of this.seen.keys()) {
      if (this.seen.size <= THROTTLE_KEYS) break;
      this.seen.delete(oldest);
    }
  }
}

export type DoorState = "reserved" | "active";

export type StateAnswer =
  | { status: 200; body: { valid: true; operatingName: string; state: DoorState } }
  | { status: 404; body: { error: "no_such_id" } }
  | { status: 429; body: { error: "slow_down" } };

export type Refusal = { reason: string; id: string; connection: string };

type Enquiry = typeof schema.enquiries.$inferSelect;

export interface DoorDeps {
  db: Db;
  now?: () => number;
  /** Sends the ID to its email. Replaced in tests. */
  send?: (to: string, message: { subject: string; text: string; html: string }) => Promise<string>;
  /** Where refusals go, with a reason code and no full ID (§9.8). */
  logRefusal?: (r: Refusal) => void;
}

const escapeHtml = (s: string): string =>
  // The regexp matches only the five defined map entries.
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/* "Send it again": the same ID, to the email they applied with. No link and
   no token: the ID is the identifier, and the button opens the sign-up. */
export function resendIdEmail(o: { cdId: string; operatingName: string; openUrl: string }) {
  const subject = "Your CurrencyDesk ID";
  const text =
    `You asked us to send your CurrencyDesk ID for ${o.operatingName} again.\n\n` +
    `Your CurrencyDesk ID: ${o.cdId}\n\n` +
    `It's the same ID as before. Type it in to open your desk: ${o.openUrl}\n\n` +
    `Didn't ask for this? Your ID can't open your desk alone. ` +
    `If you think someone else has it, reply to this email and we'll reissue it.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#17140F">` +
    `<p style="font-size:15px;line-height:1.6">You asked us to send your CurrencyDesk ID for ${escapeHtml(o.operatingName)} again.</p>` +
    `<div style="font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:26px;font-weight:700;letter-spacing:.12em;margin:20px 0;padding:16px 0;text-align:center;background:#F6F1E7;border-radius:12px">${escapeHtml(o.cdId)}</div>` +
    `<p style="font-size:15px;line-height:1.6">It's the same ID as before. Type it in to open your desk.</p>` +
    `<p><a href="${escapeHtml(o.openUrl)}" style="display:inline-block;background:#1D6B45;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Open my desk</a></p>` +
    `<p style="font-size:13px;color:#6E675E;line-height:1.6">Didn't ask for this? Your ID can't open your desk alone. If you think someone else has it, reply to this email and we'll reissue it.</p>` +
    `</div>`;
  return { subject, text, html };
}

export const operatingNameOf = (row: { details: Record<string, unknown> | null; name: string | null }): string => {
  const shop = String((row.details ?? {}).shopName ?? "").trim();
  return shop || "Your desk";
};

/* Which applications an ID opens: an accepted Early Access application,
   minted an ID, not declined or on hold. "accepted" means the desk opened. */
const OPENABLE = ["invited", "accepted"] as const;

export const resendBody = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

export function createIdDoor(deps: DoorDeps) {
  const now = deps.now ?? Date.now;
  const missesById = new Throttle(MISS_LIMIT, MISS_WINDOW_MS, LOCK_MS, now);
  const missesByConnection = new Throttle(MISS_LIMIT, MISS_WINDOW_MS, LOCK_MS, now);
  const resendByEmail = new Throttle(RESEND_PER_EMAIL, RESEND_WINDOW_MS, 0, now);
  const resendByConnection = new Throttle(RESEND_PER_CONNECTION, RESEND_WINDOW_MS, 0, now);
  const credentialById = new Throttle(12, MISS_WINDOW_MS, 0, now);
  const credentialByConnection = new Throttle(30, MISS_WINDOW_MS, 0, now);
  const send = deps.send ?? ((to, m) => sendEmail(to, m.subject, { text: m.text, html: m.html, sensitive: true }));
  const logRefusal = deps.logRefusal ?? ((r: Refusal) =>
    console.warn(`[onboarding refused] ${r.reason} id=${r.id} connection=${emailHash(r.connection)}`));

  async function findByCdId(cdId: string) {
    const rows = await deps.db
      .select()
      .from(schema.enquiries)
      .where(and(eq(schema.enquiries.cdId, cdId), eq(schema.enquiries.kind, "early_access"), inArray(schema.enquiries.status, [...OPENABLE])))
      .limit(1);
    return rows[0];
  }

  /* The reservation a sign-in may be saved against, within the credential
     limits. The connection is counted before the lookup. The ID is counted
     only once it names a reservation, so a made-up ID costs the connection
     that sent it a miss and never takes a place in the per-ID table. */
  async function findForCredential(cdId: string, connection: string): Promise<{ row: Enquiry } | { refused: "slow_down" | "no_such_id" }> {
    if (!credentialByConnection.take(connection)) {
      logRefusal({ reason: "credential_rate_limit", id: idTail(cdId), connection });
      return { refused: "slow_down" };
    }
    const row = await findByCdId(cdId);
    if (!row) {
      missesByConnection.hit(connection);
      logRefusal({ reason: "credential_unknown_id", id: idTail(cdId), connection });
      return { refused: "no_such_id" };
    }
    if (!credentialById.take(cdId)) {
      logRefusal({ reason: "credential_rate_limit", id: idTail(cdId), connection });
      return { refused: "slow_down" };
    }
    return { row };
  }

  /** What a typed ID may learn: the shop's operating name, and that it is valid. */
  async function state(raw: string, connection: string): Promise<StateAnswer> {
    const cdId = normalizeCdIdInput(raw);
    const idKey = cdId ?? `shape:${String(raw).slice(0, 40).toUpperCase()}`;
    const tail = cdId ? idTail(cdId) : "invalid";
    if (missesByConnection.locked(connection) || missesById.locked(idKey)) {
      logRefusal({ reason: "id_locked", id: tail, connection });
      return { status: 429, body: { error: "slow_down" } };
    }
    const row = cdId ? await findByCdId(cdId) : undefined;
    if (!row) {
      const idClosed = missesById.hit(idKey);
      const connectionClosed = missesByConnection.hit(connection);
      logRefusal({ reason: idClosed || connectionClosed ? "id_miss_lock" : "id_unknown", id: tail, connection });
      return { status: 404, body: { error: "no_such_id" } };
    }
    return {
      status: 200,
      body: { valid: true, operatingName: operatingNameOf(row), state: row.status === "accepted" ? "active" : "reserved" },
    };
  }

  /* The work behind "Send it again". Runs after the 202 has gone. */
  async function deliver(email: string, openUrl: string): Promise<void> {
    const rows = await deps.db
      .select()
      .from(schema.enquiries)
      .where(and(
        sql`lower(${schema.enquiries.email}) = ${email}`,
        eq(schema.enquiries.kind, "early_access"),
        inArray(schema.enquiries.status, [...OPENABLE]),
        isNotNull(schema.enquiries.cdId),
      ));
    for (const row of rows) {
      const cdId = row.cdId!;
      const status = await send(row.email, resendIdEmail({ cdId, operatingName: operatingNameOf(row), openUrl }));
      await audit(deps.db, {
        tenantId: row.tenantId ?? PLATFORM_TENANT, legalEntityId: "-", branchId: "-",
        action: "cd_id.resent",
        detail: { enquiryId: row.id, id: idTail(cdId), email: emailHash(email), delivery: status },
      });
    }
  }

  /** Always 202. Returns the work so a test can wait for it; the route does not. */
  function resend(email: string, connection: string, openUrl: string): Promise<void> {
    if (!resendByConnection.take(connection)) {
      logRefusal({ reason: "resend_connection_limit", id: "-", connection });
      return Promise.resolve();
    }
    if (!resendByEmail.take(email)) {
      logRefusal({ reason: "resend_email_limit", id: `email:${emailHash(email)}`, connection });
      return Promise.resolve();
    }
    return deliver(email, openUrl).catch((err: unknown) => {
      console.error(`[onboarding resend-id failed] email=${emailHash(email)} ${err instanceof Error ? err.name : "delivery_error"}`);
    });
  }

  /** A failed step against a real ID (a refused passkey, a wrong account): counts like a miss. */
  function fail(cdId: string, connection: string, reason: string): void {
    missesById.hit(cdId);
    missesByConnection.hit(connection);
    logRefusal({ reason, id: idTail(cdId), connection });
  }

  /** Closed for this ID or this connection right now. */
  const closed = (cdId: string, connection: string): boolean => missesById.locked(cdId) || missesByConnection.locked(connection);

  function reset(): void {
    for (const t of [missesById, missesByConnection, resendByEmail, resendByConnection, credentialById, credentialByConnection]) t.clear();
  }

  return { state, resend, reset, findByCdId, findForCredential, fail, closed, logRefusal };
}

export type IdDoor = ReturnType<typeof createIdDoor>;
