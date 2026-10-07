# Singapore pack (`pack-sg-v1`)

A new desk whose country is Singapore, SG, or Republic of Singapore opens
on this pack, in SGD. A desk that is already open is not moved. The public
site stays Not live. Canada is the only Live country.

Read 7 Oct 2026. The Notice is MAS Notice PSN01, last revised 30 June 2025,
issued under the Financial Services and Markets Act, section 16. The
licence is the Payment Services Act 2019. The suspicious-transaction duty
is the Corruption, Drug Trafficking and Other Serious Crimes (Confiscation
of Benefits) Act 1992 (CDSA), section 45.

## What the till enforces

Money changing, more than 5,000 SGD. Exactly 5,000 does not. This is
PSN01 paragraph 7.3(d) and paragraph 7.42. Paragraph 2.2 says an SGD
amount includes the equivalent in any other currency. One SGD leg is used
as written. A cross with no SGD leg uses the newest market snapshot, not
the shop board. A missing or stale rate blocks an unverified customer,
because the 5,000 line cannot be tested. A verified customer has no amount
test left, so a missing rate does not block them.

A cross-border money transfer, any amount, when there are no business
relations. PSN01 paragraphs 7.3(c) and 7.43. In this product that is
`remittance`, `remittance_send`, and `remittance_receive`. The stored
remittance cell is NULL. The gate does not read it. NULL or 0 cannot turn
the check off.

A domestic electronic transfer, a bill payment, or a money order, more
than 5,000 SGD. A money order is not given the remittance gate. This
product cannot mark an electronic transfer as cross-border. A cross-border
wire that the product books as `eft` is tested only above 5,000, which is
narrower than paragraph 7.3(b). That is a gap, recorded below.

Cheque cashing has no line. It is not a specified payment service in this
Notice. Virtual currency has no row. A digital payment token service is a
different notice. If a virtual-currency row is later stored as NULL or 0,
the gate blocks, so a stored 0 cannot mean the check is off. An absent row
does not invent a 5,000 line.

The book must be SGD. Any other home currency is refused.

A desk may set a lower money-changing line. That tighter line is at or
above. A line that is not strictly below 5,000 does not loosen the pack.
A desk line cannot lift a cross-border transfer off every deal.

The screen does not compare the amount to the line. It sends the typed
currency legs to the ledger and renders `identificationRequired`. The
comparison is Decimal, the same test posting uses.

Purpose and source of funds are not hard required. Paragraph 7.18 says
"as appropriate", and not for a specified money-changing transaction. The
report column is 0, which the generic reader treats as no cash line. That
reader would otherwise demand purpose on every deal. This pack skips it.

## What is listed, and not done

Suspicious transaction report. CDSA section 45 and PSN01 paragraph 18.2:
to the STRO, as soon as is reasonably practicable, regardless of amount,
including an attempt. The deadline columns have no unit for that phrase,
so both are NULL. The desk does not decide suspicion, does not file, and
does not open SONAR. A copy to MAS is on request. It is not sent from here.

Record retention, five years. PSN01 paragraph 16.3. The product does not
delete records.

## What is a gap

Linked or split deals. Notice paragraph 7.4 is the duty: where the
licensee suspects transactions are related, linked, or split to evade
the Notice, they are one transaction and their values are added.
Guidelines paragraphs 7-2-2 and 7-10-1 say when to enquire. They do
not replace paragraph 7.4. This desk does not add the deals. The hour
window is NULL, not 24. The screen says the teller has to check.

Sanctions screening. Paragraphs 7.51 to 7.53 require screening a
customer, and wire originators and beneficiaries, against lists from
MAS and other Singapore authorities. No list is loaded. The owner
does that screening outside this desk. The OFAC, UN, and OSFI names
in the compliance screen are not shown on a Singapore desk.

Wire message content. Paragraph 15. At or below 1,500 SGD the message
needs the originator name and an account or a unique reference. Above
1,500 SGD it also needs an address, a national identity number, or date
and place of birth. Paragraph 15.11 says the ordering institution does
not execute the wire if it cannot comply. This desk does not build the
message and does not refuse a transfer for a missing field. The row is
kind `other`, so the screen does not grow a wire report.

Cash payout of a cross-border wire to a beneficiary in Singapore.
Paragraph 15.13: identify and verify the beneficiary if not previously
verified, any amount. The till does not separate that payout.

Licence class. Payment Services Act 2019, section 6: a money-changing
licence, or a standard or major payment institution licence that includes
money-changing. The First Schedule defines money-changing as buying or
selling foreign currency notes, and cross-border money transfer as
accepting money in Singapore to transmit to a person outside Singapore,
or receiving money from outside Singapore for a person in Singapore. The
desk does not record which licence the shop holds.

A cross-border wire the product can only book as `eft` is not on the
any-amount gate. See above.

CDSA section 62: a person who receives cash, above the prescribed amount,
that was moved to them from outside Singapore reports within five business
days. A counter exchange is not that receipt. The till cannot tell, so it
does not raise the report from a deal.

## What does not apply

There is no cash transaction report for a money changer.

CDSA section 60 is the cash movement report. A traveller reports cash
moved into or out of Singapore above the prescribed amount (more than
20,000 SGD, including a bearer negotiable instrument). That is not a
report the till files when it changes notes.

CDSA Part 6B, sections 66 to 68, is a cash transaction report for a
prescribed person. The STRO list of that class is regulated dealers and
pawnbrokers. A money changer is not in it.

The Precious Stones and Precious Metals (Prevention of Money Laundering
and Terrorism Financing) Act 2019, section 17, is a cash transaction
report for a regulated dealer, cash or cash equivalent above 20,000 SGD.
A money-changing licensee is not a regulated dealer. The pack does not
store 20,000.

MAS Notice 626 is the bank notice. It is not this pack. The money-changer
notice is PSN01.

## The identifiable-source doubt

A specified money-changing transaction is one that does not exceed
20,000 SGD where the money is funded from an identifiable source, or
otherwise does not exceed 5,000 SGD. An identifiable source, in the
Payment Services Regulations 2019, regulation 28(7), is an account with a
financial institution supervised for AML/CFT, including customer due
diligence, by MAS or by an overseas AML/CFT authority.

Cash notes at the counter are not that account. Requiring customer due
diligence above 5,000 SGD for counter cash is the Notice.

A money-changing deal funded from such an account, between 5,000.01 and
20,000 SGD, is a specified money-changing transaction. Paragraphs 7.3(d)
and 7.42 do not require customer due diligence for it. The till does not
see that account, so the pack does not grant the exemption. Those deals
are blocked when the Notice does not require the check. That is the
over-enforcement this pack accepts, and it is the largest doubt in the
reading.
