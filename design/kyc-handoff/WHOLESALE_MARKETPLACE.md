# Wholesale Banknote Marketplace — Product & Revenue Exploration

A third revenue stream for CurrencyDesk OS: let desks **order physical foreign cash**
from wholesale banknote suppliers inside the OS, and take a margin on every order.

Status: **exploration / not built.** This doc is the thinking to pressure-test before
committing engineering. It reuses surfaces you already have (Vault, Branch Network,
Reports) rather than inventing a new app.

---

## 1. Why this is the strongest of the three streams

You have three ways to make money per desk:

1. **Subscription** — steady, predictable, but capped by seat/desk count.
2. **KYC margin** — high margin, but low volume (a few mandatory checks/day; the $3.99
   re-screen is a *behaviour bet*, not a floor). Good sweetener, not the base.
3. **Banknote marketplace** — **frequent, large-ticket, and sticky.** Desks reorder
   inventory constantly — far more often than they run enhanced KYC — and the dollar
   value per order dwarfs a verification. This is the volume engine.

The strategic prize: it **closes the loop.** Rate board → deal → compliance check →
inventory runs low → reorder — all in one system. Once a desk runs both compliance *and*
inventory through you, switching cost is enormous. That's what turns "nice software" into
"the operating system for the desk," and it justifies a higher subscription tier.

## 2. How desks buy cash today (the problem)

- Phone/email/portal orders to one or two wholesale suppliers (banknote wholesalers,
  correspondent banks, armoured-carrier-linked desks).
- Opaque pricing — the desk rarely knows if today's wholesale spread is competitive.
- Manual reconciliation: an order arrives, someone hand-keys it into inventory.
- No link between "I'm short EUR at this till" and "place an order."

CurrencyDesk OS already knows the desk's live position (Vault + Till + Branch Network) and
its sell-through (Ledger). That context is exactly what makes a *smart* ordering experience
possible — and what a standalone supplier portal can never offer.

## 3. The order-money flow (in-OS)

Lives as a tab in **Cash on Hand · Vault** (and surfaced from Branch Network):

1. **Reorder signal.** Vault shows position by currency; when a currency drops below a
   par level (desk-set, or suggested from sell-through velocity), it surfaces a
   *"Low — reorder"* nudge. Same nudge language as the KYC rail (blue = suggestion).
2. **Build the order.** Pick currencies + denominations + amounts. OS pre-fills a
   suggested basket from velocity (e.g. "you sell ~€4k/week, 12 days cover = €7k").
3. **Live quotes.** One or more connected suppliers return a wholesale rate + fee +
   delivery window. Desk sees them **side by side** — the transparency wedge.
4. **Place order.** Confirm → order goes to the supplier; OS books an *incoming* vault
   entry (pending), so the position math already reflects it.
5. **Receive & reconcile.** On delivery, one tap moves pending → on-hand; the Ledger/Vault
   reconcile against the packing figures. No re-keying.
6. **Record.** Every order is logged, receipted, audit-ready (same discipline as KYC).

## 4. Revenue model — three levers

| Lever | Mechanic | Notes |
|---|---|---|
| **Interchange / referral fee** | A few basis points on every order routed through the platform, paid by the supplier for the deal flow. | Cleanest, most defensible. Supplier pays for demand aggregation. |
| **FX spread share** | Share of the wholesale spread on each order. | Larger $ but needs supplier agreements; watch that it doesn't worsen the desk's price. |
| **Float / settlement** | If you ever intermediate settlement, short-lived float. | **Later / maybe** — adds money-transmission licensing burden; don't design for it v1. |

**Illustrative:** a desk ordering ~$40–80k/mo of banknotes at even **15–25 bps** to the
platform = **$60–200/desk/mo**, on top of subscription — and it *grows with the desk's
volume* instead of being capped by seats. Across 500 desks that's a $0.4–1.2M/yr line by
itself, and it's the least behaviour-dependent of the three streams.

Pricing principle (mirror the KYC ethic): **the desk should get a better, more
transparent price than calling suppliers manually** — the platform earns by aggregating
demand, not by widening the desk's cost. That's what makes it defensible and ethical.

## 5. Partnerships — what to line up

- **2–4 wholesale banknote suppliers** willing to expose live quotes via API (or, v1, a
  managed price sheet you refresh). Start with the ones your founding desks already use —
  warm intros, and it removes onboarding friction.
- **Armoured / logistics** for delivery windows and tracking (can be the supplier's, v1).
- **Legal:** confirm the platform's role is *facilitation*, not money transmission, in each
  jurisdiction. Taking a referral/bps fee is materially lighter than touching settlement —
  keep v1 on that side of the line.

## 6. Build phasing

- **v0 (validate, no code):** manual concierge — desks request a reorder in-app, you place
  it with the supplier, confirm the bps economics with 3–5 founding desks. Prove desks
  *want* to order here and suppliers will pay for the flow.
- **v1 (MVP):** managed price sheets (not live API), the reorder nudge from Vault position,
  order → pending vault entry → receive/reconcile, order log. One or two suppliers.
- **v2:** live multi-supplier quotes side-by-side, velocity-based basket suggestions,
  par-level automation, cross-branch consolidation of orders.
- **v3:** predictive reordering from sell-through, seasonal/FX-aware timing.

## 7. Open questions to resolve before building

- Will suppliers pay bps for aggregated demand, or only share spread? (Determines lever 1 vs 2.)
- Minimum order sizes / delivery cadence — does the reorder-nudge cadence fit real logistics?
- Licensing line per jurisdiction (facilitation vs. transmission) — get this answered first.
- Does exposing side-by-side quotes risk suppliers refusing to compete on-platform? (Pilot with cooperative ones.)
- Inventory data model: this shares the Vault/Branch schema — confirm it can represent
  *pending/in-transit* stock cleanly (the receive/reconcile step depends on it).

---

**Bottom line:** this is the volume-and-stickiness stream that de-risks the whole business
model. It leans on data you already own (position + velocity), reuses existing surfaces,
and — priced like the KYC rail (earn by aggregating, not by widening the desk's cost) —
it's defensible. Validate with a no-code concierge pilot among the founding desks before
writing the v1.
