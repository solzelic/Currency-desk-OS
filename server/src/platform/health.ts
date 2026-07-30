/* ============================================================
   Is anything broken right now?

   WHY THIS IS A PAGE AND NOT A HABIT

   The rate boards stopped reaching one desk's storefront and nobody knew
   until a person looked at the site. That is the shape of every outage
   this business will have: a thing that is only visibly wrong from
   outside, discovered by the customer. So the checks that would have
   caught it live here, on one screen, answered in one sentence each.

   A check says one of four things:
     ok    — working, nothing to do
     warn  — working, but something will bite soon
     down  — not working, customers can see it
     off   — deliberately not set up yet, which is not a fault

   `off` matters. "Stripe is not connected" is true and is not an outage,
   and a dashboard that screams about it teaches you to ignore red.
   ============================================================ */
import { desc, eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { stripeBillingConfig } from "../billing/stripe.js";
import { hasHostedSite } from "../sites.js";
import { delivery } from "../comms.js";

export type CheckState = "ok" | "warn" | "down" | "off";

export interface Check {
  id: string;
  title: string;
  state: CheckState;
  /* One sentence, in the words somebody would use out loud. Not a metric. */
  detail: string;
  /* What to do about it, when there is something to do. */
  fix?: string;
  /* Where in the panel to go and deal with it. */
  href?: string;
}

const RATES_STALE_MINUTES = 180;

export async function systemHealth(db: Db): Promise<{ state: CheckState; checks: Check[] }> {
  const checks: Check[] = [];

  /* The database. Not "can we connect" — we are already connected — but
     how long a trivial read takes, which is the first thing to move when
     something is wrong underneath. */
  const t0 = Date.now();
  let dbOk = true;
  try {
    await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
  } catch {
    dbOk = false;
  }
  const ms = Date.now() - t0;
  checks.push({
    id: "database",
    title: "Database",
    state: !dbOk ? "down" : ms > 1500 ? "warn" : "ok",
    detail: !dbOk
      ? "A simple read failed. Nothing in the panel can be trusted until this clears."
      : ms > 1500
        ? `Answering, but slowly — ${ms}ms for a single row.`
        : `Answering in ${ms}ms.`,
  });

  /* Email. The one that will embarrass you at scale: sends fall back to
     the log when the provider is unset, so forty invitations can appear
     to work and reach nobody. */
  const mail = delivery();
  checks.push({
    id: "email",
    title: "Email",
    state: mail.live ? "ok" : "off",
    detail: mail.detail,
    fix: mail.fix ?? undefined,
    href: "#/comms",
  });

  /* Money. Not connected is a fact, not a fault — but a paying customer
     with no way to be charged is worth saying plainly. */
  const stripe = stripeBillingConfig();
  const paying = (await db.select().from(schema.tenants)).filter((t) => !t.suspended && t.plan !== "trial");
  checks.push({
    id: "stripe",
    title: "Stripe",
    state: stripe ? "ok" : paying.length ? "warn" : "off",
    detail: stripe
      ? "Connected. Subscriptions and invoices flow through to billing."
      : paying.length
        ? `Not connected, and ${paying.length} desk${paying.length === 1 ? " is" : "s are"} on a paid plan — nothing is being charged.`
        : "Not connected yet. Nothing is being charged, and nothing is on a paid plan.",
    fix: stripe ? undefined : "Set STRIPE_SECRET_KEY and the price ids.",
    href: "#/billing",
  });

  /* Rates. A board published from a stale pull is a board quoting
     yesterday's market on a live shop window. */
  const newest = (await db.select().from(schema.marketRates).orderBy(desc(schema.marketRates.fetchedAt)).limit(1))[0];
  const ageMin = newest ? Math.round((Date.now() - newest.fetchedAt.getTime()) / 60000) : null;
  checks.push({
    id: "rates",
    title: "Market rates",
    state: process.env.RATES_SYNC === "off" ? "off" : ageMin == null ? "warn" : ageMin > RATES_STALE_MINUTES ? "down" : "ok",
    detail:
      process.env.RATES_SYNC === "off"
        ? "Syncing is turned off for this environment."
        : ageMin == null
          ? "No market pull has ever landed. Boards can only be published by hand."
          : ageMin > RATES_STALE_MINUTES
            ? `Last pull was ${ageMin} minutes ago. Storefronts are showing rates that old.`
            : `Last pull ${ageMin} minute${ageMin === 1 ? "" : "s"} ago, from ${newest!.provider}.`,
  });

  /* The one that actually bit. A desk with a public address whose site
     has never had a board published shows a visitor no rates at all —
     and it is invisible from in here unless something goes looking. */
  const tenants = await db.select().from(schema.tenants);
  const withSite = tenants.filter((t) => t.siteSlug && hasHostedSite(t.siteSlug));
  const silent: string[] = [];
  for (const t of withSite) {
    const board = (await db.select({ id: schema.rateBoards.id }).from(schema.rateBoards)
      .where(eq(schema.rateBoards.tenantId, t.id)).limit(1))[0];
    if (!board) silent.push(t.name);
  }
  checks.push({
    id: "storefronts",
    title: "Customer storefronts",
    state: !withSite.length ? "off" : silent.length ? "down" : "ok",
    detail: !withSite.length
      ? "No desk has a storefront deployed yet."
      : silent.length
        ? `${silent.length} of ${withSite.length} live site${withSite.length === 1 ? "" : "s"} show no rates at all: ${silent.join(", ")}.`
        : withSite.length === 1
          ? "The one live site is serving a published board."
          : `All ${withSite.length} live sites are serving a published board.`,
    fix: silent.length ? "Somebody at that desk has to press Publish on their rate board." : undefined,
    href: "#/desks",
  });

  /* Worst wins. A dashboard that averages its way to green is worse than
     no dashboard, because you stop opening it. */
  const rank: Record<CheckState, number> = { ok: 0, off: 0, warn: 1, down: 2 };
  const state = checks.reduce<CheckState>((w, c) => (rank[c.state] > rank[w] ? c.state : w), "ok");
  return { state, checks };
}
