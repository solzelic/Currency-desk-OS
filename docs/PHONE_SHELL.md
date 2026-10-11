# Phone shell

The phone desk is one layout. Every screen PR tonight uses these components
and these rules. Names and props below are the contract. Do not rename them
in a screen PR.

## Principles

A cashier is standing at the counter, often one-handed. The phone app uses
the same layout on every screen, in plain words.

- One main button. It is a `StickyAction` pinned above the tab bar.
- Tap targets are at least 48px for a primary control and at least 44px
  for any target.
- Pressed states, and words for status. Colour is never the only signal.
- Honest loading, empty, and error. A figure the ledger cannot answer is
  absent, never zero (`docs/ABSENT_FIGURES.md`).
- Amounts always show the currency code (`1,765.05 CAD`), never a bare `$`.
  Every amount goes through `formatPhoneMoney`.
- The tab bar is five tabs: Rates, Ledger, Clients, Till, More. No centre
  plus. A screen that has a `StickyAction` does not also float a
  New transaction button.
- Phone rules apply only at `max-width: 430px`. Wider than that, the desk
  is the desktop desk.

## Money

```js
window.CDOS.formatPhoneMoney(amount, code)
window.CDOS.Phone.formatMoney(amount, code)   // the same function
```

`formatPhoneMoney(1765.05, 'CAD')` is `1,765.05 CAD`.
`formatPhoneMoney(1200, 'JPY')` is `1,200 JPY`.
`formatPhoneMoney(1.234, 'BHD')` is `1.234 BHD`.
A negative uses a minus sign (U+2212): `formatPhoneMoney(-5, 'USD')` is
`−5.00 USD`.

Grouping is `Intl` `en-CA` with fraction digits set by hand. It is not
`style: 'currency'`, which prints `$`.

Minor units match `EXCEPTIONS` in `server/src/ledger/currencies.ts`.
The browser cannot import that file. The lists live in
`os-src/cdos-phone.jsx` and the comment there says to change both together.

- 0 places: BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF
- 3 places: BHD IQD JOD KWD LYD OMR TND
- everything else: 2

`null`, `undefined`, `''`, a non-finite number, or a code that is not three
letters returns `''`. A real zero is `0.00 CAD` (or `0 JPY`). Absent stays
absent.

## Where the chrome lives

The desk shell owns one top bar (`.phone-head`) and one tab bar
(`#phone-dock`). They stay mounted while apps change. `Phone.Screen` is the
column between them: optional title, scroll, optional sticky action. It sets
`data-app` and `data-phone-shell`.

`top` and `tabs` are optional nodes for a screen shown on its own. More does
not pass them, because the desk already drew that chrome. `banner` is an
optional node pinned above the scroll. More uses it for search.

`data-app` sets `--brand-primary` from `os-src/tokens.css`. Values match
`APP_ACCENT` in `os-src/cdos-base.jsx`. `data-app="more"` is ink. An app
opened from More paints the More tab in that app's accent. That colour is
the existing tab logic, not a second one.

Every phone window root (`.win`) sets `data-app` to the app id, including
a duplicate window (`ledger~2` is still `ledger`). `Phone.Screen` sets it
too. Inside that root, `--brand-primary` is that app's accent.

On a phone, a legacy primary button whose fill is `var(--cd-ink)` and
whose label is semibold white paints with `--brand-primary`. That is
the Ledger **New transaction** button, the Clients **New contact**
button, and the same kind of button in other apps. A selected filter
chip does not. Legacy chips marked `data-filter-chip` and `FilterChips`
both use `--gray-900` with white text, in every app. The selected
bottom tab and the other accents named in the design system still use
`--brand-primary`. The rule lives in `os-src/phone-shell.css` and only
applies at `max-width: 430px`, so the desktop keeps the near-black ink.

## Components

All of these are on `window.CDOS.Phone`.

### TopBar

`shop` string. `desk` string (station, till, and the words "Till open" or
"Till closed"). `tillOpen` boolean (the green dot; the words are the
non-colour signal). `unread` boolean — the bell dot renders only when this
is true. `onBell` opens the real alerts surface (Compliance). `avatar` is
a node; the desk passes the existing account button.

The shop name is `.phone-shop`. The till line is a sibling, `.phone-till`.

### Title

`title` string. `subtitle` optional string. `action` optional node.

### SummaryCards

`cards` array of `{ id?, label, value, caption?, onClick? }`. `columns` is
`2` or `3`. Values are what the caller passes. Format money before it
arrives here.

### Search

`value` string. `onChange(string)`. `placeholder` string. `label` string
for the input's accessible name. One row, 48px. The clear button calls
`onChange('')`. `type="text"` so there is one clear button, ours.

### FilterChips

`chips` array of `{ id, label, count? }`. `value` is the selected id.
`onChange(id)`. One scrolling line, snap, no scrollbar. The chip face is
36px inside a 44px hit. Selected is `--gray-900` with white text, in
every app. Legacy selected chips use the same fill. The row fades at
the right edge.

### ListRow

`title` string. `subtitle` optional. `note` optional (a reference line,
mono 12px). `amount` optional (already formatted).
`meta` optional. `leading` optional node. `badge` optional
`{ label, tone }` where `tone` is `buy`, `sell`, `warn`, `pos`, `neg`, or
`neutral`. The badge text is the status; the colour repeats it.
`chevron` boolean. `onClick` optional. `danger` boolean. `className`
optional. `disabled` boolean. `appId` optional — set only on an app row.
It adds `data-phone-app`, `phone-more-row`, and `phone-more-name`. Session
rows do not set it.

A row is at least 56px. Title and subtitle ellipsis.

### ListSection

`title` string. `meta` optional string. Children are the rows.

### StickyAction

`label` string. `onClick`. `disabled` optional boolean. `disabledReason`
optional string, shown under the button when `disabled` is true. One
primary button, full width, 48px. The reason is how a cashier knows why
the button will not go.

### EmptyState

`title`, `message`. `actionLabel` and `onAction` optional.

### LoadingState

`rows` optional, default 4. `label` optional, default "Loading".
`role="status"`. Skeleton rows, not a fake list.

### ErrorState

`message` string. `onRetry` optional. `role="alert"`. The button says
"Try again".

### Screen

`app` optional string (`data-app` omitted when absent). `title`, `subtitle`,
`action` optional, forwarded to Title. `top` optional node. `banner` optional
node, pinned above the scroll. `tabs` optional node. `sticky` optional node.
`children`. `className` optional.
`data-phone-shell` is always set. Scroll padding keeps the last row above
the sticky action and the tab bar.

### TabIcon

`name` is `rates`, `ledger`, `clients`, `till`, or `more`. The glyphs are
the one-colour tab icons. Desktop icons are not these, and are not changed.
The wrapper is `display: contents` so the existing tab stroke rules still
apply.

### More

`allowed` string[] — app ids this role can already open. `accent` is the
`APP_ACCENT` map. `onOpen(id)`, `onLock`, `onHandover`, `onSignOut`.

More does not grant access. The desk passes `visibleApps` with Texts
(`telegraph`) and Branches removed, then adds `store` when `planAllows('store')`
and `permsOk('store')`. The desktop edge rail already opens the store.
That is the same door, not a new one. Texts and Branches stay on the
desktop dock and stay off this list.

Browse groups, in order. A group with nothing this role can open is omitted.

| Group | Apps |
| --- | --- |
| Money | Transfers, Cheques, Vault |
| Checks | Compliance, Tagged deals, Audit trail |
| Numbers | Reports, Dashboard |
| Tools | Calculator, Loan calculator, Assistant |
| Shop setup | Pricing, Apps, Settings |

Each row is the app's coloured icon (accent on an 11% tint, 40px) and a
one-line purpose.

Your session, under the groups: Lock the desk, Hand over the desk, Sign out.
They call the existing lock, handover, and sign-out flows. Sign out asks
first: the row arms, and the sticky button "Sign out" confirms. The first
tap does not sign out. The till is not closed.

Search matches the name, the purpose line, and a keyword list on each app.
Every word in the query must match. `cash` finds Cheques, Vault, Compliance,
and Till for a role that can open them. Vault is missing from the results
when this role cannot open Vault. Rates, Ledger, Clients, and Till are not
in the browse groups. When the query matches one of them, they are listed
under "On the bottom bar". The browse list has no search footer. A query
shows "Search looks at app names and what each app does." Nothing matches
is an empty state. There is no "Example data" badge. That tag is mockups only.

## Phone sweep

Every phone screen PR imports `tests/e2e/helpers/phone-sweep.ts` and runs
it on that screen. The helper sets 360×780 and 390×844 and checks each
root:

- Every visible interactive control is at least 44×44 CSS pixels.
  Controls are `button`, `a[href]`, `input`, `select`, `textarea`,
  `summary`, and `role` of button, tab, link, checkbox, switch, menuitem,
  or option.
- Visible text is at least 12px.
- Text contrast is at least 4.5:1. Text that is 24px or larger, or at
  least 18.66px and bold (weight 700), may be 3:1.
- Visible text has no 24-hour time. The pattern is
  `\b([01]?\d|2[0-3]):[0-5]\d\b`. A time with AM or PM beside it is allowed.
- Visible text has no ISO date (`\d{4}-\d{2}-\d{2}`).

```ts
import { phoneSweep } from "./helpers/phone-sweep";

await phoneSweep(page, {
  roots: ["#phone-more", ".phone-head", "#phone-dock"],
  exceptions: [
    { rule: "date", text: "TX-2026-10-11-0041", reason: "Reference id, not a calendar date." },
  ],
});
```

`roots` are the screen's own nodes, so a window underneath is not part of
this screen. An exception names the rule (`hit`, `size`, `contrast`,
`time`, or `date`), a reason, and a text substring or a CSS selector.
An exception that matches nothing fails the sweep. The shell runs this
on More and on the phone ledger, each with the phone header and the tab bar.

## Adopting the shell

1. Render inside `Phone.Screen` with `app` set to the app id. A window
   the desk already opens gets `data-app` on `.win`. Do not leave a phone
   screen without it.
2. Pass real ledger and server data. Do not invent ids. Do not invent figures.
3. Format every amount with `formatPhoneMoney` before it reaches a card,
   a row, or a button.
4. One `StickyAction` for the screen's main button. Pass `disabledReason`
   whenever it is disabled. Do not add a floating New transaction button
   on that screen.
5. Lists are `ListRow` and `ListSection`, not a table that has to scroll
   sideways to be read.
6. A status badge has words. Do not communicate state by colour alone.
7. Keep phone CSS inside `@media (max-width: 430px)`.
8. Run `phoneSweep` on the screen at 360 and 390. See Phone sweep above.

## Not in this foundation

Screen PRs add these in their own files. Do not build them here.

NavRow, ProfileRow, Toggle, FullScreenSheet, PinPad, Toast, ChoiceTiles,
AmountField, SummaryList, StepHeader.

More is one proof screen. The ledger is the other. Under 430px the
ledger window is a `Phone.Screen`: title, Records and Compliance,
summary cards, search, type select, `FilterChips`, `ListRow`s grouped
by day, and a sticky **New transaction**. Amounts use
`formatPhoneMoney`. Times are 12-hour. The figures are the ledger's
own rows; an empty book says so. The desktop ledger is the same tree
it was: the in-page New transaction, the table, and the folder tabs.
Records and Compliance stay on both.
