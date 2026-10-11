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
  Every amount goes through `formatPhoneMoney`. A clock goes through
  `formatPhoneTime` (`3:02 PM`). A calendar day goes through
  `formatPhoneDate` (`Jun 18, 2026`). Pass a `YYYY-MM-DD` string for a
  calendar day. Do not pass that day through `new Date`.
- The tab bar is five tabs: Rates, Ledger, Clients, Till, More. No centre
  plus. A screen that has a `StickyAction` does not also float a
  New transaction button.
- Phone rules apply only at `max-width: 430px`. Wider than that, the desk
  is the desktop desk.
- A task sheet covers the tab bar. A confirm stays a bottom sheet above it.

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

Grouping is en-CA (commas, a period, the code after the number). The
digits are formatted from the string, not from a float. It is not
`style: 'currency'`, which prints `$`.

Minor units match `EXCEPTIONS` in `server/src/ledger/currencies.ts`.
The browser cannot import that file. The lists live in
`os-src/phone/format.js` and the comment there says to change both together.

- 0 places: BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF
- 3 places: BHD IQD JOD KWD LYD OMR TND
- everything else: 2

`null`, `undefined`, and `''` return `''`. A code that is not three
letters returns `''`. A malformed amount (`0x10`, `1,2,3`, `1e2`, a
number past `Number.MAX_SAFE_INTEGER`) is an em dash (`—`), never a
parsed guess. A real zero is `0.00 CAD` (or `0 JPY`). Absent stays
absent. A decimal string such as `9007199254740993.25` keeps every digit.

`os-src/cdos-base.jsx` still has an earlier helper of the same name. The
script in `os-src/phone/format.js` loads later and is the one the phone
uses. `Phone.formatMoney` is that function.

## Time

```js
window.CDOS.formatPhoneTime(value, timeZone)
window.CDOS.Phone.formatTime(value, timeZone)   // the same function
```

`formatPhoneTime('15:02')` is `3:02 PM`. `formatPhoneTime('00:00')` is
`12:00 AM`. `formatPhoneTime('12:00')` is `12:00 PM`. The suffix is
uppercase, as in `10:16 AM`. The phone does not follow the desktop
24-hour setting.

`timeZone` is the branch zone (`settings.timezone`). A wall clock does
not need one. An instant with no zone is an em dash. The formatter
does not assume Toronto.

A wall clock (`15:02`, `2026-06-18 15:02`, `2026-06-18T15:02:00` with no
`Z` and no numeric offset) is already a local time. The zone does not
move it. `13:02 AM` is not a clock. It is an em dash. `13:02` with no
suffix is `1:02 PM`.

A `Date`, or a string that ends in `Z` or a numeric offset, is an
instant. `2026-06-18T19:02:00Z` is `3:02 PM` in `America/Toronto` and
`7:02 PM` in `UTC`. The same instant with no zone is an em dash.

A blank returns `''`. A bad zone or a value with no clock is an em dash.

## Date

```js
window.CDOS.formatPhoneDate(value, timeZone)
window.CDOS.Phone.formatDate(value, timeZone)   // the same function
```

`formatPhoneDate('2026-06-18')` is `Jun 18, 2026`. The same string is
`Jun 18, 2026` in `America/Toronto`, `UTC`, `Pacific/Honolulu`, and
`Pacific/Kiritimati`. The formatter reads the year, month, and day off
the string. It does not pass that string to `Date`, so UTC midnight
cannot move the day.

An instant uses the calendar day in the branch zone the caller passes.
`2026-06-18T03:30:00Z` is `Jun 17, 2026` in `America/Toronto`.
A `Date` built from `2026-06-18` alone is that UTC midnight instant,
and it does move. Callers pass the `YYYY-MM-DD` string.
An instant with no zone is an em dash.

`2026-02-31` and `2026-02-29` are not days. They are an em dash.
`2024-02-29` is `Feb 29, 2024`.

A blank returns `''`. A value with no calendar day is an em dash.

## List groups

```js
window.CDOS.formatPhoneListGroup(value, today)
window.CDOS.Phone.formatListGroup(value, today)   // the same function
```

`formatPhoneListGroup('2026-10-11', '2026-10-11')` is `Today, Oct 11`.
`today` is the business date, `YYYY-MM-DD`.
`formatPhoneListGroup('2026-10-08', '2026-10-11')` is `Oct 8, 2026`.
A date on a form stays `formatPhoneDate`
(`Jun 18, 2026`). The group reads the day off the string. It does
not pass that string to `Date`.

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

The shop name is `.phone-shop-name`, one line. A long name ends in
an ellipsis.

The till line is a sibling, `.phone-till`, and it is one line. The
desk name (the first segment, `.phone-till-part.is-desk`) is what
the ellipsis cuts first. The till name is cut only after the desk
name is gone. Every segment is joined with ` · `, including a closed
till and a teller's till (`Front Desk 01 · Till 1 · Till closed`).
The gap is `.phone-till-sep`. The words `Till open` or `Till closed`
stay whole, in `.phone-till-state`, at the end of the line. The
header stays 56px tall at 360 and at 390.

### Title

`title` string. `subtitle` optional string. `action` optional node.

The title block uses `padding-top: var(--space-4)` (16px), so the
heading starts 16px under the top bar. Side padding is 16px. The
heading starts at least 16px in from the screen edge. The block keeps
`var(--space-3)` (12px) before the next element, which is search or
the chip row on a screen that leads with those. That 12px is the
title's own bottom padding. The scroll under a title does not add a
top pad, and a search or chip row that is the next element does not
add a top margin.

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
every app. Legacy selected chips use the same fill. The first chip
starts 16px in from the screen edge. The row keeps 16px after the
last chip. The right edge fades. Scroll-snap does not pull the first
chip back to the edge.

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

`title` optional string. `message` string. `onRetry` optional.
`role="alert"`. The title is the heading. The message is the body under
it. The button says "Try again" and uses the open app's accent.

### Screen

`app` optional string (`data-app` omitted when absent). `title`, `subtitle`,
`action` optional, forwarded to Title. `top` optional node. `banner` optional
node, pinned above the scroll. `tabs` optional node. `sticky` optional node.
`children`. `className` optional.
`data-phone-shell` is always set. The screen paints `--color-surface`
with no background image, so the desktop window's radial does not
show through the title. Scroll padding keeps the last row above
the sticky action and the tab bar.

### TabIcon

`name` is `rates`, `ledger`, `clients`, `till`, or `more`. The glyphs are
the one-colour tab icons. Desktop icons are not these, and are not changed.
The wrapper is `display: contents` so the existing tab stroke rules still
apply.

### More

`allowed` string[] — app ids this role can already open. `accent` is the
`APP_ACCENT` map. `onOpen(id)`, `onLock`, `onHandover`, `onSignOut`.

More does not grant access. The desk passes `visibleApps`, then adds
`store` when `planAllows('store')` and `permsOk('store')`. The desktop
edge rail already opens the store. That is the same door, not a new one.

Texts (`telegraph`) is on this list only when the session says
`smsConfigured`. That is the flag `sendSms` uses: Twilio account,
token, and a from-number, messaging service, or WhatsApp sender.
Without it, texts are simulated and the row stays off the phone.
The desktop dock still has Texts.

Branches and the AI Assistant stay off this list. The Branches window
invents cash in the browser and does not read `/api/desk/branches`.
The Assistant calls `window.claude.complete` and has no model API.
Both remain on the desktop dock.

Browse groups, in order. A group with nothing this role can open is omitted.

| Group | Apps |
| --- | --- |
| Money | Transfers, Cheques, Vault |
| Checks | Compliance, Tagged deals, Audit trail |
| Numbers | Reports, Dashboard |
| Tools | Texts (only when Twilio is set up), Calculator, Loan calculator |
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

## Seam locators

An inactive window stays in the document. At 430px and under it is not
shown. The window carries the same `data-app` as its dock button.

A seam test opens an app with `#appbar [data-app="…"]`. It reads and
presses the screen through `.win.show.active`. A drawer count uses
`.win.show.active button.till-chip`. A document-wide `[data-app]`
click matches the dock and the open window. A document-wide currency
chip can be a button in a window that is no longer on screen.

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
  least 18.66px and bold (weight 700), may be 3:1. The dark shell
  does not use that exception: Clients and Ledger at 360, 390, and
  430 require 4.5:1 for every text pair, including the 24px title.
- Visible text has no 24-hour time. The pattern is
  `\b([01]?\d|2[0-3]):[0-5]\d\b`. A time with AM or PM beside it is allowed.
- Visible text has no ISO date (`\d{4}-\d{2}-\d{2}`).

The dark colours are the `html[data-cdtheme="dark"]` block in
`os-src/tokens.css`, inside `max-width: 430px`. Wider than that the
block does not apply, so a 1280 picture is not those tokens.
`tests/e2e/phone-shell.spec.ts` measures Clients and Ledger at 360,
390, and 430 and fails when a pair is under 4.5:1.

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

## Task sheets

Under 430px a task is the whole phone. It covers the tab bar, keeps
its own sticky footer, and closes with a 44px control. The class is
`.phone-task` on the overlay and `.phone-task-sheet` on the panel.
`.phone-task-close` is the 44px close. `.phone-task-foot` is the
footer. `.phone-task-go` is the main button, and it has to be the
element under its own centre.

`Phone.TaskSheet` is that structure. Props: `title`, `subtitle`,
`onClose`, `actionLabel`, `onAction`, `actionDisabled`, `children`.
New transaction, Record the ID, Move cash (Give out a float is
Issue float), Cash a cheque, and New transfer use the classes.
Send money and Cash a cheque inside New transaction are that same
sheet. A FullScreenSheet is a task sheet too. FullScreenSheet itself
is not in this foundation. A screen that has one uses `Phone.TaskSheet`.

A small confirm stays above the bar. `.phone-confirm` is the scrim,
ending at the top of `#phone-dock`. `.phone-confirm-sheet` is the
card. `Phone.ConfirmSheet` takes `title`, `message`, `confirmLabel`,
`onConfirm`, `cancelLabel`, `onCancel`. Discard this deal? uses it.
Sign out asks with the sticky button on More, which is also above
the bar. Neither is a task sheet.

Wider than 430px the classes do nothing. The desktop dialogs stay
the dialogs they were.

## Desktop baselines

`tests/e2e/desktop-unchanged.spec.ts` is the one desktop picture for the
whole desk. At 1280×800 it captures the menu bar, the open window, and
the dock for every app — Ledger, Clients, Rates, Till, Compliance,
Reports, Settings, Pricing, Transfers, Cheques, Vault, and Audit — and
the sign-in screen (`#lock`). The PNGs are a render of the main commit
named in `tests/e2e/README.md`, taken in the browser-seam job, not a
render of a feature branch and not a laptop. The same job renders that
commit twice, and all 13 pictures have to match at every pixel.
Animations and the caret are off. The sign-in card in the product is
still the glass card. The capture turns `backdrop-filter` off for
that shot, because two renders of main with the blur on differed by
6 pixels at channel delta 8. The fonts are loaded and the device
scale is 1. Turning the blur off in the product and swapping the PNG
hid the desktop: the old picture was not a mid-animation frame, and
the replacement did not match main. The menu bar's brand dot stays
the circle the desk draws. Any differing pixel fails. A channel that
moves fails. The text is Archivo and Space Mono from
`tests/e2e/fonts/`, served in place of `fonts.googleapis.com`, for the
main capture and for the branch compare. The picture is refused when
those faces have not loaded. A one-character change in a rate, a code,
an amount, a fee, a hold date, or a cheque number fails the picture.

The page clock is `2026-06-18T15:02:00.000Z` (15:02 on the menu bar,
3:02 PM where the desk uses a 12-hour clock). The audit seed's
`2026-06-18 09:05` paints 9:05 AM, so an AM/PM swap is in the Audit
picture. "2m ago" is that same clock, not a string written after render.

The Cheques picture is one seeded cheque: number `48120`, hold date
`2026-06-23`, face `1200.00`, fee `5.00`, customer
`cust_11111111-1111-4111-8111-111111111111`. The USD mid on the rate
board is `1.3914`, written into `yorkfx_rates_v1` before the page
scripts run. The embedded board stays on its sign-in form at 1280, which is what
main paints. The editor opens only when the parent page is at most
430px wide. The "Updated" line is written
only when the words change. Ledger lists that other tests already posted
are not drawn. The clients list is the empty server answer, and the
cash drawer is told the branch has one till, so a contact or a second
drawer created earlier in the suite cannot enter the picture. Nothing
rewrites the text after it renders.

Inter's CSS is added only when `matchMedia('(max-width: 430px)')`
matches. A desktop load does not request it. `--font-ui` names Inter
only inside that same query in `os-src/tokens.css`.

A screen PR must never update these baselines. Do not run
`--update-snapshots` on this spec. Do not replace a PNG to make the
check pass. If the spec fails, the desktop changed. That is a
blocker. Phone work stays inside `max-width: 430px` and leaves these
pixels alone.

## Adopting the shell

1. Render inside `Phone.Screen` with `app` set to the app id. A window
   the desk already opens gets `data-app` on `.win`. Do not leave a phone
   screen without it.
2. Pass real ledger and server data. Do not invent ids. Do not invent figures.
3. Format every amount with `formatPhoneMoney` before it reaches a card,
   a row, or a button. Format a clock with `formatPhoneTime` (`3:02 PM`)
   and a calendar day with `formatPhoneDate` (`Jun 18, 2026`). A list
   heading for the business day uses `formatPhoneListGroup`
   (`Today, Oct 11`). Pass `YYYY-MM-DD` for a calendar day. All four
   live in `os-src/phone/format.js`.
4. One `StickyAction` for the screen's main button. Pass `disabledReason`
   whenever it is disabled. Do not add a floating New transaction button
   on that screen.
5. Lists are `ListRow` and `ListSection`, not a table that has to scroll
   sideways to be read.
6. A status badge has words. Do not communicate state by colour alone.
7. Keep phone CSS inside `@media (max-width: 430px)`.
8. Run `phoneSweep` on the screen at 360 and 390. See Phone sweep above.
9. Do not update `tests/e2e/desktop-unchanged.spec.ts-snapshots/`.
   A failure there means the desktop changed. See Desktop baselines.
10. A task dialog uses `Phone.TaskSheet` (or the `.phone-task` classes).
    It covers the tab bar. A confirm uses `Phone.ConfirmSheet` and
    stays above the bar.

## Not in this foundation

Screen PRs add these in their own files. Do not build them here.

NavRow, ProfileRow, Toggle, FullScreenSheet, PinPad, Toast, ChoiceTiles,
AmountField, SummaryList, StepHeader.

FullScreenSheet is one of those. When a screen builds it, the sheet
is a `Phone.TaskSheet`. Do not give it a second full-screen treatment.

More is one proof screen. The ledger is the other. Under 430px the
ledger window is a `Phone.Screen`: title, Records and Compliance,
summary cards, search, type select, `FilterChips`, `ListRow`s grouped
by day, and a sticky **New transaction**. Amounts use
`formatPhoneMoney`. Times are 12-hour. The figures are the ledger's
own rows; an empty book says so. The desktop ledger is the same tree
it was: the in-page New transaction, the table, and the folder tabs.
Records and Compliance stay on both.
