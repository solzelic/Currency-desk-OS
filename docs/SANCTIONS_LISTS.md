# Official lists

Checked live on 15 Nov 2026 before the parsers were written. The desk stores
the address below, the fetch time, and a SHA-256 of the bytes. It stores the
parsed names, not a second copy of the file. A failed fetch keeps the last
good snapshot and sets `sanctions_ops_flags.alert`. It does not delete entries.

The score threshold defaults to 0.92 in `SCORE_THRESHOLD_PLACEHOLDER`. That
number is a placeholder pending Compliance Officer sign-off. It is not final.
`signed_off` stays false until that sign-off is recorded.

A date of birth rules a name out only when both sides have a full day and
none of those days are the same. A missing date, a year-only date, or a
match on any one of several listed days stays a possible match.

## Global Affairs Canada

Consolidated Canadian Autonomous Sanctions List (SEMA and JVCFOA), official XML:

https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml

15 Nov 2026: HTTP 200, `text/xml`, 2,922,327 bytes, root `data-set`, 5,781
`record` elements. Fields used: `LastName-NomDeFamille`, `GivenName-Prenom`,
`EntityOrShip-EntiteOuNavire`, `Aliases-Alias` (semicolon separated),
`DateOfBirthOrShipBuildDate-DateDeNaissanceOuDateDeConstructionDuNavire`,
`Schedule-Annexe`, `Item-NumeroDarticle`, `Country-Pays`. A ship or entity
date is not treated as a person's date of birth.

## Security Council consolidated list

Official XML:

https://scsanctions.un.org/resources/xml/en/consolidated.xml

15 Nov 2026: HTTP 200, `application/xml`, about 2.2 MB. Root
`CONSOLIDATED_LIST`, `dateGenerated` 2026-11-15, 733 `INDIVIDUAL` elements
and 274 `ENTITY` elements. Names are `FIRST_NAME` through `FOURTH_NAME`.
Aliases are `ALIAS_NAME` inside `INDIVIDUAL_ALIAS` or `ENTITY_ALIAS`. A date
of birth is `DATE` or `YEAR` inside `INDIVIDUAL_DATE_OF_BIRTH`. The stable
id is `DATAID`.

That address redirects to a short-lived file host. The snapshot stores the
official address above, not the redirected address, and not any query string
on the redirect.

## Criminal Code listed entities

Public Safety Canada, currently listed entities. There is no feed this desk
treats as the source. The parser reads the official page:

https://www.publicsafety.gc.ca/cnt/ntnl-scrt/cntr-trrrsm/lstd-ntts/crrnt-lstd-ntts-en.aspx

15 Nov 2026: HTTP 200, HTML. 76 headings of the form `<h2 id="NUMBER">`.
Each block contains `<strong>Also known as</strong>` and
`<strong>Date listed</strong>`. Aliases are separated by semicolons or the
word "and". The page also links `/cnt/_xml/lstd-ntts-eng.xml`. This build
does not fetch that file. If the numbered headings or either label
disappear, the parser throws and the fetch is a failure. The last good
list stays.

## Hold

A possible match, or a confirmed one, stops `POST /api/quotes/:id/post`.
The teller response is only `{ code: "NEEDS_REVIEW", message: "This needs review. A supervisor will help." }`.
The owner or a compliance officer uses `GET /api/screening/reviews`.
Clearing stores the actor and the reason and lets a later post through
for that same list entry. Confirming keeps the deal held. A changed list
re-screens existing clients.

Tiers 1 and 2 (`quick` and `verify` as well as `1` and `2`) record whether
the client said they are a politically exposed person, and the date.
`server/src/screening/provider.ts` is the later vendor seam for PEP and
adverse media. Nothing calls it.

## Schedule

`listenServer` fetches these three once a day. `SCREENING_FETCH=off` skips
it. That switch is set by the browser test harness. It is not a Render
environment change. Production leaves it unset.
