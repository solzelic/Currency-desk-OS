# Serbia pack (`pack-rs-v1`)

The first Serbia pack. Nothing older is edited. A desk already open stays
on the pack it has until somebody opts it in. A new desk that picks Serbia
opens on this one.

Migration `033_serbia_pack`. Open drafts already use 027 and 029 through
031. If a rebase has to renumber this file, change the filename, the id in
`server/src/db/migrations.ts`, and the header of the SQL together. Do not
edit a migration that has already been applied.

## Sources, read 2026-10-07

- Zakon o sprečavanju pranja novca i finansiranja terorizma, consolidated
  text on paragraf.rs
  (`https://www.paragraf.rs/propisi/zakon_o_sprecavanju_pranja_novca_i_finansiranja_terorizma.html`).
  Header on that page: Sl. glasnik RS 113/2017, 91/2019, 153/2020, 92/2023,
  94/2024, 19/2025. The official publisher
  (pravno-informacioni-sistem.rs) was not fetched separately.
- Odluka o uslovima i načinu obavljanja menjačkih poslova, NBS consolidated
  PDF through 24/2026
  (`https://www.nbs.rs/export/sites/NBS_site/documents/propisi/propisi-dev/menjaci_202603_p.pdf`).
  Gazette header: Sl. glasnik RS 84/2018, 86/2018, 53/2020, 32/2022,
  67/2022, 39/2023, 21/2025, 31/2025, 111/2025, 113/2025, 2/2026, 12/2026
  and 24/2026. Latin mirror on paragraf.rs was used to read Points 21 and
  23.
- APML, the Administration for the Prevention of Money Laundering:
  `https://www.apml.gov.rs`. Named as the financial intelligence unit.
  The site itself was not fetched on 2026-10-07.

## What the pack stores

| Field | Value |
| --- | --- |
| Pack | `pack-rs-v1`, jurisdiction `RS`, version 1, kind country |
| Name | Serbia |
| Home currency | RSD |
| Regulator | NBS / APML |
| Single `id_threshold` | 5000 (the exchange line; the column has no currency of its own) |
| `report_threshold` | 15000 |
| `report_currency` | EUR |
| `aggregation_hours` | null, meaning deals are not added together |
| `retention_years` | 5 |

Signup maps Serbia, RS, and Republic of Serbia to this pack and forces the
book to RSD. The wizard and the sixteen-screen onboarding both offer
Serbia on the existing signup path. They do not store 5000 as a dinar
override: the euro line is not the home currency, so
`legal_entities.id_threshold` stays null and a tighter dinar line is set
later in Settings.

## Article and point against the implementation

| Source | What it says | What the desk does |
| --- | --- | --- |
| Art 4(1)(2) | An authorised exchange office is an obligor. | The pack is that obligor. It is not applied to a desk that did not pick Serbia. |
| Art 109 | The National Bank of Serbia supervises those offices. Art 104 lists supervisors; 109 is the one that names exchange offices. | Regulator string is `NBS / APML`. NBS is the supervisor. APML is the FIU the reports name. |
| Art 8(2), Art 10 | Exchange business: customer due diligence at 5,000 EUR or more, one deal or linked deals, before the transaction. | `fx` line: 5000 EUR, `gte`, diligence `cdd`, not cash-only. Posting refuses an unverified customer at or above the dinar equivalent, before the row is written. |
| Art 8(1)(3) | A transfer of funds higher than 1,000 EUR, one deal or linked deals, when there is no business relationship. "Higher than" is not "at or more". | `remittance` and `eft` lines: 1000 EUR, comparator `gt`, diligence `cdd`. |
| Art 8(1)(2) | Occasional transaction of 15,000 EUR or more. Art 8(2) replaces that line for exchange business only. | `virtual_currency` line: 15000 EUR, `gte`. Digital-asset rules written in dinars are not copied. |
| Art 47(1) | Each cash transaction of 15,000 EUR or more, in dinar countervalue, to APML immediately and at latest within 3 days. Not a 24-hour sum. | Report `rpt-rs-ctr`: 15000 EUR, `gte`, cash only, direction both, window `none`, deadline `calendar_days` 3. "Immediately" is in `format_rules`. The desk does not send the report. |
| Art 47(2) | Reasons to suspect money laundering or terrorist financing: report to APML before the transaction is carried out. No amount. | Report `rpt-rs-str`: kind suspicious, deadline `before_execution`, no threshold. The till has no suspicion flag. Filing the report is not a permanent block: the article allows the deal after the report. |
| Art 95 | Keep the data 5 years, then delete (stav 4). A competent authority may extend by up to 5 more years after a proportionality assessment (stav 6). | `retention_years` is 5. Nothing deletes a row. Nothing adds the extra five years. |
| NBS Point 23 | Every transaction has a receipt (`potvrda`) with 13 fields. | The fields the desk can already refuse a deal for are enforced. The rest are gaps, listed below. Cash against dinars stores `otkup` with basis `796/701`, or `prodaja` with basis `700/701`. |
| NBS Point 21 notice item 2 | A sale of USD 50 and 100 notes records the name, the JMBG or passport number, and the serial number of each note. | On `pack-rs-v1`, a cash exchange that pays out USD must say whether those notes are included. Yes requires a non-empty name, a JMBG or passport number, and the serials. No does not. There is no US serial-number pattern and no JMBG checksum. |
| NBS Point 21 notice item 4, locations in Point 3 stav 5 | Airside (international airport or port, behind border control) or a casino gaming space: every buy and sell of foreign cash records the name and the JMBG or passport number. | `branches.airside_or_casino`, default false, set in Settings. On for a Serbia cash exchange: the customer must already be verified, and the name and number are required. Remittances and cheques are not covered by the flag. |
| NBS Point 21(7) and Point 25 | A cash journal (`dnevnik blagajne`) may be kept in software. | The till ledger is that journal for the amounts it already posts: each deal, the rate, the time, the currencies, the fee amount, and the opening and closing till balances. Gaps are listed below. A second journal is not built. |

## How a euro amount becomes dinars

`market_rates` stores CAD per 1 unit. RSD per EUR is CAD-per-EUR divided by
CAD-per-RSD. The result is rounded down to the cent (`ROUND_DOWN`, two
decimal places) and the rate is stored on the deal at 12 decimal places
(`compliance_threshold_rate`). The shop's board mid is not used.

Same currency needs no snapshot. A missing snapshot, one older than 24
hours, or a missing mid makes the foreign line unpriced. An unverified
customer is then refused. A verified customer is not refused for the
missing rate alone, and the receipt is not told that the euro line was
met. That is the same fail-closed spirit as the international baseline:
no fresh rate, no unidentified deal.

The statute names the NBS official middle rate on the day of the
transaction. This snapshot is not that rate. The gap is written on
`rpt-rs-ctr.format_rules`. No NBS feed was added, and board mids are not
overwritten.

A desk override stored in dinars can only add a refusal (at or above that
dinar figure). It cannot loosen the euro line.

Linked deals (`međusobno povezane`) are a qualitative test in the statute,
not a clock. `aggregation_hours` is null. Deals are not summed. The column
used to refuse null; null now means not added together. Packs seeded
before this migration still store 24.

## Receipt fields (Point 23)

The thirteen fields, and where each one stands:

1. Exchanger's name. On the legal entity. The printed receipt still says CurrencyDesk OS. Gap.
2. Exchange place, name and address. The branch has a name. A full street address may live only in tenant setup, not on the branch row. Gap.
3. Till code. The till id is on the transaction. Collected.
4. Buy or sell (`otkup` / `prodaja`). Stored for a cash deal with dinars on one side. A cross with no dinar side is not guessed. Gap for that cross.
5. Receipt number that does not repeat and cannot be changed after the first issue. The transaction reference is server-owned and the row is append-only. Collected, as that reference.
6. Name plus JMBG or passport number, at or above the AML amount and wherever else the law requires it. Enforced when the identification line is met, when USD 50/100 notes are sold, and when the counter is airside or a casino. The number is `identity_number` on the insert. There is no checksum.
7. Basis codes. Cash purchase `796` and `701`. Cash sale `700` and `701`. Stored on `receipt_facts` for those two cases. Cheque basis `795` and `699` is not written. Cheque cashing uses the exchange identification line and does not call the Serbia receipt check. Gap.
8. Currency code, foreign amount, dinar amount. On the transaction. Collected.
9. Rate. On the transaction, and copied onto `receipt_facts`. Collected.
10. Commission percent and the amount from Point 12(1). The fee amount can be on the deal. The percent is not. Gap.
11. Date and time. `posted_at`. Collected.
12. Place. Not a separate receipt field beyond the branch. Gap, same as item 2.
13. Teller signature or their code. The actor id is the code. A signature image is not stored. The code satisfies "or their code".

## Cash journal

The till ledger records each posted exchange, the rate, the time, both
currencies, the fee amount, and the opening and closing balances of the
till session. That is the software cash journal for those facts.

It does not put the NBS basis code on every journal line, it does not
print a daily signature, and it does not split exchange-business cash
from other activity on the same till. Those remain gaps.

## Known gaps

- Linked transactions are not detected. Each line is a single deal.
- The market snapshot is not the NBS official middle rate.
- Neither the cash report nor the suspicion report is sent to APML.
- There is no suspicion control on the till. A teller who suspects reports outside the desk, then the deal may proceed. The desk does not trap the deal.
- Article 95's deletion, and the extra five years, are not implemented.
- Point 21 notice item 3 (other denominations, on request) is not implemented.
- Cheque deals and a cross with no dinar side do not get the Serbia receipt facts.
- Receipt gaps listed above: legal name on the print, street address, commission percent, cheque basis codes.
- JMBG is stored as typed. It is not checked as a 13-digit identity number.
- USD serials are stored as typed, up to 200 values, each 1 to 40 characters.
- `aggregation_hours` null is new. A reader that assumed 24 now shows "Not added together" when the effective window is null.

## Public pages

Serbia is listed with the other countries as Available. It is not labelled
Live. Canada remains Live. The compliance coverage line counts Live and
Available separately.
