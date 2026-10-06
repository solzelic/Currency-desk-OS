# Sanctioned jurisdictions

The list lives in `server/src/compliance/sanctioned-jurisdictions.ts`.
It is versioned (`SANCTIONS_LIST_VERSION`) and each entry carries the
instrument, the URL, and the date that source was current. The browser
does not keep a copy. Signup, transfers, and deal posting all call
this module.

`lookupSanctionedJurisdiction` and `lookupSanctionedCurrency` are the
functions other features call. A currency lookup is exact on the ISO
code (`CUP`, `IRR`, `KPW`, `MMK`). A name lookup is exact on the whole
string after normalisation. "Korea" is not North Korea. "DPR" is
Donetsk. "DPRK" is North Korea.

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

Kherson and Zaporizhzhia are matched on the oblast name. The measures
cover the occupied part of the oblast. Matching the name also catches
the government-controlled part, because the file cannot see which side
of the line an address is on.

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

## Where it is enforced

1. A desk cannot sign up with a listed country, and cannot set its
   country to one. The check is on the existing signup post, on
   saving onboarding answers, on launch, and again inside
   `provisionDesk`, which is the only function that creates a desk.
   There is no second signup path.
2. A transfer cannot be sent to or received from a listed country.
   The code is `SANCTIONED_JURISDICTION`. A corridor cannot name a
   region, so occupied Ukrainian regions are not blocked as corridors.
3. A deal with a client in a listed country or region is stopped.
   The code is the pack's report whose `format_rules` contain
   `sanctionsStop`. That is `SANCTIONS-STOP` on `pack-intl-v1` and
   `TPR` (Terrorist Property Report) on `pack-ca-v1`. A corridor
   block is decided first, so a send to a listed country stays a
   transfer block even when the client is listed too.

A walk-in ledger customer with no `desk_clients` row has no country
to read. Only the corridor can stop that deal.

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
5. A new report code for a pack is a new migration. Do not edit a
   merged one. Flag the row with
   `format_rules = format_rules || '{"sanctionsStop": true}'`.
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
