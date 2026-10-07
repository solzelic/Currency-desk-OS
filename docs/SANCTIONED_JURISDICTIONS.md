# Sanctioned jurisdictions

The list lives in `server/src/compliance/sanctioned-jurisdictions.ts`.
It is versioned (`SANCTIONS_LIST_VERSION`, currently `2026-10-07.1`)
and each entry carries its tier, the instrument, the URL, and the
date that source was current. The browser does not keep a copy.
Signup, transfers, and deal posting all call this module.

Two tiers live on the same data, so a country can move between them
later without a code change:

- **blocked.** A desk cannot open there. A transfer cannot touch it.
  A deal with a client there is stopped. The stop code is always
  `SANCTIONS-STOP`. It is not a row on a jurisdiction pack.
- **enhanced due diligence.** The deal can post. The client must be
  identified in full, whatever the amount, and the deal must carry a
  short reason and source of funds. Those two notes are the
  `purpose` and `source_of_funds` already stored on the deal.

`lookupSanctionedJurisdiction` and `lookupSanctionedCurrency` are the
functions other features call. A currency lookup is exact on the ISO
code (`CUP`, `IRR`, `KPW` are blocked; `MMK` is enhanced due
diligence). A name lookup is exact on the whole string after
normalisation: case, extra whitespace, and diacritics are ignored.
"Korea" is not North Korea. "DPR" is Donetsk. "DPRK" is North Korea.
Official spellings match too: "Iran, Islamic Republic of",
"Korea, Democratic People's Republic of", "Myanmar (Burma)", "Burma".

A bare two-letter token is an ISO country code. It matches a country
field only. A region field does not read it, so a Pakistani region
stored as `KP` is not North Korea. "NK" is not an alias. On a region
field, a trailing Oblast, Region, Province, or City is dropped once,
so "Donetsk Oblast" is Donetsk.

The client country picker stores the ISO alpha-2 code and shows the
English name. Older free-text values ("Canada", "Iran") are still read.

## What the list is

Comprehensive country-wide programs only:

- UN measures that apply to a country, not only to listed persons
- Canada, under the Special Economic Measures Act, where the ban
  reaches anyone in the country or a named occupied region
- EU country-wide or named-region restrictive measures
- US OFAC comprehensive programs
- FATF "call for action" (the blacklist), not the increased-monitoring
  list

A regional program stays a region, with `parentCountry` set. It is not
promoted to a country code. Ukraine is not sanctioned. A transfer
corridor is an ISO alpha-2 code, so a corridor of `UA` is allowed. A
client whose country, region, or incorporation jurisdiction names a
listed region is stopped.

Donetsk, Luhansk, Kherson, and Zaporizhzhia are matched on the whole
oblast. That is deliberately broader than the occupied part. The
measures name the occupied part. This list matches the oblast, so a
government-controlled address in the same oblast is stopped as well.
Kherson and Zaporizhzhia are not cited to US Executive Order 14065.
Donetsk and Luhansk are. Canada SOR/2014-60 section 4.2 and EU
Regulation 2022/263 cover all four.

Cuba is blocked as a conservative business choice. OFAC's program is
comprehensive. Canada, the EU, the UN, and FATF do not have a
country-wide program. The desk still refuses Cuba.

Myanmar is the enhanced due diligence tier, not a block. FATF's June
2026 call for action asked for enhanced due diligence, not
countermeasures, and said remittances should not be disrupted.

## What was left off, and why

Checked 2026-10-06.

- Syria. US comprehensive sanctions ended with Executive Order 14312
  on 30 June 2025. The Promoting Accountability for Assad and Regional
  Stabilization Sanctions program is list-based. Canada repealed the
  broad SEMA sectoral measures by SOR/2026-23 on 13 February 2026.
  The EU lifted its economic sanctions in May 2025 (Council Decision
  (CFSP) 2025/1096).
- Russia, Belarus, and Venezuela. Targeted or sectoral programs, not
  a ban on the whole country.
- Other UN regimes that list people, entities, or an arms embargo
  and do not close the country.
- The FATF increased-monitoring list (the grey list).
- Canada's SEMA Iran regulations, which are list-based plus a goods
  schedule. Iran is on this list because of OFAC's comprehensive
  program and the FATF call for action, not because of SEMA.
- The UN snapback on Iran, which reimposed nuclear-related measures.
  It is not a ban on every person in Iran.

## Known gaps

Russia and Belarus banknote restrictions are out of scope for this
list. A desk can still buy and sell those notes. This file does not
claim to enforce cash-instrument rules that name a currency without
closing the country.

## Where it is enforced

1. A desk cannot sign up in a blocked country, and cannot set its
   country to one. The check is on the existing signup post, on
   `PUT /api/onboarding/:ref/state`, on `PATCH /api/onboarding/:ref`,
   on launch, and again inside `provisionDesk`, which is the only
   function that creates a desk. There is no second signup path.
   Enhanced due diligence does not refuse a desk.
2. Every send and every receive must name a corridor, so a walk-in
   transfer can be checked. A transfer cannot be sent to or received
   from a blocked country. The code is `SANCTIONED_JURISDICTION`.
   The payout currency on a send, and the sent currency on a receive,
   are checked the same way, so an IRR, KPW, or CUP payout through
   another corridor is still stopped. MMK is enhanced due diligence,
   not a stop. A corridor cannot name a region, so occupied Ukrainian
   regions are not blocked as corridors. A corridor of UA is allowed.
3. A deal with a client in a blocked country or region is stopped.
   The code is always `SANCTIONS-STOP`, on every pack, including
   Canada. It is not looked up from `jurisdiction_reports`. A blocked
   corridor is decided first, then a blocked currency, then the
   client, so a send to a blocked country stays a transfer block even
   when the client is blocked too.
4. A deal or transfer that touches an enhanced due diligence
   jurisdiction, and is not already blocked, forces full
   identification regardless of amount and requires a short reason
   and source of funds before it posts. Those notes are recorded on
   the deal. The code while they are missing is `COMPLIANCE_BLOCKED`.

A stopped deal rolls back, so the ledger row is not kept. The stop
itself is written to `audit_events` afterwards, on a different
connection: who, which desk, what was blocked, which jurisdiction,
and the list version. Action `sanctions.stop`. If that write fails,
the failure is logged (identifiers and list version, not the
client's name) and the request fails. The deal stays unposted.

A walk-in ledger customer with no `desk_clients` row has no country
to read. The corridor and the payout or sent currency can still stop
that deal.

Quote creation is not a posted deal. The stop runs when the deal is
posted.

## How to update the list

1. Read the official pages below. Do not copy a secondary write-up
   that still names a program the publisher has ended.
2. Edit only `server/src/compliance/sanctioned-jurisdictions.ts`.
   Do not hard-code a country in the UI, and do not put the list on
   a pack threshold.
3. Bump `SANCTIONS_LIST_VERSION`. Set `SANCTIONS_LIST_CHECKED` to the
   day you read the pages. Set each source `asOf` to the date on that
   instrument or page.
4. Keep a region a region. Do not add `UA` as a sanctioned country
   because an oblast is occupied.
5. The stop code stays `SANCTIONS-STOP`. Do not add it to a
   published pack, and do not edit `pack-ca-v1` or `pack-intl-v1`.
   Moving a country between blocked and enhanced due diligence is a
   change to `tier` on its row in this file, not a migration.
6. Run the postgres test against a fresh database:

```bash
cd server && TEST_DATABASE_URL=postgres://…/freshdb npx vitest run tests/sanctioned-jurisdictions.postgres.test.ts
```

## Sources to re-read

- OFAC programs: https://ofac.treasury.gov/sanctions-programs-and-country-information
- Cuba: https://ofac.treasury.gov/sanctions-programs-and-country-information/cuba-sanctions
- Iran: https://ofac.treasury.gov/sanctions-programs-and-country-information/iran-sanctions
- North Korea (OFAC): https://ofac.treasury.gov/sanctions-programs-and-country-information/north-korea-sanctions
- Ukraine and Russia related (OFAC): https://ofac.treasury.gov/sanctions-programs-and-country-information/ukraine-russia-related-sanctions
- UN DPRK (1718): https://main.un.org/securitycouncil/en/sanctions/1718
- Canada, current sanctions: https://www.international.gc.ca/world-monde/international_relations-relations_internationales/sanctions/current-actuelles.aspx?lang=eng
- Canada DPRK, SOR/2011-167: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2011-167/FullText.html
- Canada Ukraine, SOR/2014-60: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2014-60/FullText.html
- EU DPRK, Regulation 2017/1509: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R1509
- EU Crimea, Regulation 692/2014: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32014R0692
- EU occupied regions, Regulation 2022/263: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R0263
- EU Ukraine overview: https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/sanctions-adopted-following-russias-military-aggression-against-ukraine_en
- FATF call for action, 19 June 2026: https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/call-for-action-june-2026.html
- FATF black and grey lists: https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html
