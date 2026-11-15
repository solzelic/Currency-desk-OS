# Official lists

Checked live on 15 Nov 2026 before the parsers were written. The desk stores
the address below, the fetch time, and a SHA-256 of the bytes. It stores the
parsed names, not a second copy of the file. A failed fetch keeps the last
good snapshot and sets `sanctions_ops_flags.alert`. It does not delete entries.

The score threshold defaults to 0.92 in `SCORE_THRESHOLD_PLACEHOLDER`. That
number is a placeholder pending Compliance Officer sign-off. It is not final.
`signed_off` stays false until that sign-off is recorded.

A date of birth rules a name out only when the subject has a full day and
every listed day, month, and year disagrees with it. A missing date, a
year-only date, or any one agreeing day or year stays a possible match. A
full day plus an alternative year keeps the match when either one agrees.

A snapshot is written in one transaction. Entry batches land while the row
is `writing`, and the row becomes `good` only after the last batch. A crash
rolls that snapshot back. The previous good snapshot stays the one a screen
can read. A list over 12,000,000 bytes, or a well-formed list with more than
10 percent fewer rows than the last good snapshot, is a failed fetch: the
last good snapshot stays and `sanctions_ops_flags.alert` is set.

Name matching also keeps a shorter name when every token is on the longer
name (a missing middle name, or a short client name against a multi-part
list name) and a token that is one edit from the listed token when that
token is at least six letters. The threshold stays 0.92 until sign-off.

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

The fetch follows a redirect only when the next URL is HTTPS and its host
is one of the three official hosts in this document. A redirect to any
other host fails the fetch. The last good snapshot stays, and the ops flag
is raised. The snapshot stores the official address above, never the
redirect and never a query string from one.

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

## Schedule

`listenServer` fetches these three once a day. `SCREENING_FETCH=off` skips
it. That switch is set by the browser test harness. It is not a Render
environment change. Production leaves it unset.
