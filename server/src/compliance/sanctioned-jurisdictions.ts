/* ============================================================
   Sanctioned jurisdictions.

   One list, in the repo, so a desk, a transfer, and a deal all
   refuse the same places. The browser does not keep a copy.
   Other features call lookupSanctionedJurisdiction or
   lookupSanctionedCurrency. They do not restate the list.

   Two tiers, on the data, so a country can move later without a
   code change:

     blocked
       A desk cannot open there, a transfer cannot touch it, and a
       deal with a client there is stopped. The stop code is always
       SANCTIONS-STOP. It is not a row on a jurisdiction pack, and
       published packs are not edited to name it.

     enhanced_due_diligence
       The deal can post. The client must be identified in full,
       whatever the amount, and the deal must carry a short reason
       and source of funds. Myanmar is here because FATF asked for
       enhanced due diligence, not countermeasures, and said
       remittances should not be disrupted.

   What is blocked: comprehensive country-wide programs under the
   UN, Canada (SEMA), the EU, and US OFAC, plus the FATF call for
   action where it demands countermeasures. Cuba stays blocked as
   a conservative business choice. A program that names people,
   entities, or a sector, and leaves the rest of the country open,
   is not on this list.

   What is not a country: Crimea, Donetsk, Luhansk, Kherson, and
   Zaporizhzhia. Those are regions of Ukraine. Ukraine itself is
   not sanctioned. A transfer corridor is an ISO alpha-2 code, so
   it cannot name a region. A corridor of UA is allowed. A client
   whose region or incorporation jurisdiction names one of those
   regions is stopped. Matching the whole oblast is deliberately
   broader than the occupied part.

   How to refresh it: docs/SANCTIONED_JURISDICTIONS.md.
   Bump SANCTIONS_LIST_VERSION and the as-of date on every entry
   you re-check. Do not edit a merged migration to change this list.
   ============================================================ */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export const SANCTIONS_LIST_VERSION = "2026-10-07.1";
export const SANCTIONS_LIST_CHECKED = "2026-10-06";
export const SANCTIONS_STOP_CODE = "SANCTIONS-STOP";

export type SanctionAuthority = "UN" | "Canada-SEMA" | "EU" | "US-OFAC" | "FATF";
export type SanctionTier = "blocked" | "enhanced_due_diligence";
export type PlaceField = "country" | "region";

export type SanctionSource = {
  authority: SanctionAuthority;
  /* The instrument a reviewer can look up, in the publisher's own name. */
  instrument: string;
  url: string;
  /* The date on the instrument, or the date the official page was current. */
  asOf: string;
  note?: string;
};

export type SanctionedJurisdiction = {
  id: string;
  kind: "country" | "region";
  /* blocked stops the desk and the deal. enhanced_due_diligence
     lets the deal post once the client is fully identified and a
     short reason and source of funds are on it. */
  tier: SanctionTier;
  name: string;
  /* ISO 3166 alpha-2, or ISO 3166-2 for a region (UA-43). */
  iso: string;
  /* Set on a region. The parent country is not itself sanctioned. */
  parentCountry: string | null;
  /* ISO 4217 codes whose issue is this jurisdiction. Empty for a region. */
  currencies: readonly string[];
  aliases: readonly string[];
  sources: readonly SanctionSource[];
};

const OFAC_UKRAINE = "https://ofac.treasury.gov/sanctions-programs-and-country-information/ukraine-russia-related-sanctions";
const CANADA_UKRAINE = "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2014-60/FullText.html";
const EU_UKRAINE_OVERVIEW = "https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/sanctions-adopted-following-russias-military-aggression-against-ukraine_en";
const FATF_CALL = "https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/call-for-action-june-2026.html";
const FATF_INDEX = "https://www.fatf-gafi.org/en/countries/black-and-grey-lists.html";

/* Matching the oblast name also stops a government-controlled
   address in the same oblast. That is deliberate. The file cannot
   see which side of the line an address is on, and the desk would
   rather stop too much than let an occupied-region deal through. */
const WHOLE_OBLAST =
  "Matching the whole oblast is deliberately broader than the occupied part. The measures name the occupied part. This list matches the oblast, so a government-controlled address in the same oblast is stopped as well.";

/* Checked against the official pages on SANCTIONS_LIST_CHECKED.
   Left off on purpose, and why, is written in
   docs/SANCTIONED_JURISDICTIONS.md: Syria (comprehensive programs
   terminated), Russia, Belarus, Venezuela, list-based UN regimes,
   the FATF increased-monitoring list, and Canada's list-based
   Iran regulations. Russia and Belarus banknote restrictions are
   a known gap, not a row on this list. */
export const SANCTIONED_JURISDICTIONS: readonly SanctionedJurisdiction[] = [
  {
    id: "CU",
    kind: "country",
    tier: "blocked",
    name: "Cuba",
    iso: "CU",
    parentCountry: null,
    currencies: ["CUP"],
    aliases: ["Cuba", "Republic of Cuba", "CU"],
    sources: [
      {
        authority: "US-OFAC",
        instrument: "Cuban Assets Control Regulations, 31 CFR Part 515",
        url: "https://ofac.treasury.gov/sanctions-programs-and-country-information/cuba-sanctions",
        asOf: "2026-09-29",
        note: "Program page current on 2026-10-06. Comprehensive. Kept blocked as a conservative business choice: Canada, the EU, the UN, and FATF do not have a country-wide program.",
      },
    ],
  },
  {
    id: "IR",
    kind: "country",
    tier: "blocked",
    name: "Iran",
    iso: "IR",
    parentCountry: null,
    currencies: ["IRR"],
    aliases: ["Iran", "Islamic Republic of Iran", "Iran, Islamic Republic of", "IR"],
    sources: [
      {
        authority: "US-OFAC",
        instrument: "Iranian Transactions and Sanctions Regulations, 31 CFR Part 560",
        url: "https://ofac.treasury.gov/sanctions-programs-and-country-information/iran-sanctions",
        asOf: "2026-10-05",
        note: "Program page current on 2026-10-06. Comprehensive. Canada's SEMA Iran measures and the UN snapback are not the reason this row exists: both are narrower than a ban on the whole country.",
      },
      {
        authority: "FATF",
        instrument: "High-risk jurisdictions subject to a call for action, June 2026 (countermeasures)",
        url: FATF_CALL,
        asOf: "2026-06-19",
        note: `Blacklist index: ${FATF_INDEX}. The October 2026 plenary had not published a replacement statement on 2026-10-06.`,
      },
    ],
  },
  {
    id: "KP",
    kind: "country",
    tier: "blocked",
    name: "North Korea",
    iso: "KP",
    parentCountry: null,
    currencies: ["KPW"],
    aliases: [
      "North Korea",
      "DPRK",
      "Democratic People's Republic of Korea",
      "Korea, Democratic People's Republic of",
      "Korea, North",
      "KP",
    ],
    sources: [
      {
        authority: "UN",
        instrument: "Security Council resolution 1718 and its successor resolutions",
        url: "https://main.un.org/securitycouncil/en/sanctions/1718",
        asOf: "2026-10-06",
        note: "Country-wide financial and sectoral measures. Not an absolute ban on every personal remittance. Included because it is the UN regime that applies to the country rather than only to listed persons.",
      },
      {
        authority: "Canada-SEMA",
        instrument: "Special Economic Measures (DPRK) Regulations, SOR/2011-167",
        url: "https://laws-lois.justice.gc.ca/eng/regulations/SOR-2011-167/FullText.html",
        asOf: "2026-06-14",
        note: "Export and supply to the DPRK or any person in the DPRK, and related financial services. Justice Laws text current to 2026-06-14, read on 2026-10-06.",
      },
      {
        authority: "EU",
        instrument: "Council Regulation (EU) 2017/1509",
        url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32017R1509",
        asOf: "2026-10-06",
        note: "Country-wide restrictive measures on the DPRK.",
      },
      {
        authority: "US-OFAC",
        instrument: "North Korea Sanctions Regulations, 31 CFR Part 510",
        url: "https://ofac.treasury.gov/sanctions-programs-and-country-information/north-korea-sanctions",
        asOf: "2026-03-12",
        note: "Program page current on 2026-10-06. Comprehensive.",
      },
      {
        authority: "FATF",
        instrument: "High-risk jurisdictions subject to a call for action, June 2026 (countermeasures)",
        url: FATF_CALL,
        asOf: "2026-06-19",
        note: `Blacklist index: ${FATF_INDEX}.`,
      },
    ],
  },
  {
    id: "MM",
    kind: "country",
    tier: "enhanced_due_diligence",
    name: "Myanmar",
    iso: "MM",
    parentCountry: null,
    currencies: ["MMK"],
    aliases: ["Myanmar", "Burma", "Myanmar (Burma)", "Republic of the Union of Myanmar", "MM"],
    sources: [
      {
        authority: "FATF",
        instrument: "High-risk jurisdictions subject to a call for action, June 2026 (enhanced due diligence)",
        url: FATF_CALL,
        asOf: "2026-06-19",
        note: "FATF asked members to apply enhanced due diligence, not countermeasures, and said legitimate remittances should not be disrupted. This row is the enhanced due diligence tier. It does not stop a desk from opening and it does not stop a deal. A deal that touches Myanmar still needs the client identified in full and a short reason and source of funds, whatever the amount. The October 2026 plenary had not published on 2026-10-06.",
      },
    ],
  },
  {
    id: "UA-43",
    kind: "region",
    tier: "blocked",
    name: "Crimea and Sevastopol",
    iso: "UA-43",
    parentCountry: "UA",
    currencies: [],
    aliases: [
      "Crimea",
      "Crimea region",
      "Autonomous Republic of Crimea",
      "Republic of Crimea",
      "Sevastopol",
      "UA-43",
      "UA-40",
      "UA43",
      "UA40",
    ],
    sources: [
      {
        authority: "US-OFAC",
        instrument: "Executive Order 13685 (19 December 2014); 31 CFR Part 589",
        url: OFAC_UKRAINE,
        asOf: "2026-05-08",
        note: "Ukraine-/Russia-related program page current on 2026-10-06. Comprehensive ban on the Crimea region. Ukraine itself is not sanctioned.",
      },
      {
        authority: "Canada-SEMA",
        instrument: "Special Economic Measures (Ukraine) Regulations, SOR/2014-60, section 4.1",
        url: CANADA_UKRAINE,
        asOf: "2026-09-21",
        note: "Justice Laws text current to 2026-09-21, read on 2026-10-06. Prohibitions aimed at the Crimea region.",
      },
      {
        authority: "EU",
        instrument: "Council Regulation (EU) No 692/2014",
        url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32014R0692",
        asOf: "2026-10-06",
        note: `Restrictions on Crimea and Sevastopol. Overview: ${EU_UKRAINE_OVERVIEW}.`,
      },
    ],
  },
  {
    id: "UA-14",
    kind: "region",
    tier: "blocked",
    name: "Donetsk",
    iso: "UA-14",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Donetsk", "Donetsk People's Republic", "DNR", "DPR", "UA-14", "UA14"],
    sources: occupiedRegionSources("Donetsk", true),
  },
  {
    id: "UA-09",
    kind: "region",
    tier: "blocked",
    name: "Luhansk",
    iso: "UA-09",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Luhansk", "Lugansk", "Luhansk People's Republic", "LNR", "UA-09", "UA09"],
    sources: occupiedRegionSources("Luhansk", true),
  },
  {
    id: "UA-65",
    kind: "region",
    tier: "blocked",
    name: "Kherson",
    iso: "UA-65",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Kherson", "UA-65", "UA65"],
    sources: occupiedRegionSources("Kherson", false),
  },
  {
    id: "UA-23",
    kind: "region",
    tier: "blocked",
    name: "Zaporizhzhia",
    iso: "UA-23",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Zaporizhzhia", "Zaporizhia", "Zaporozhye", "UA-23", "UA23"],
    sources: occupiedRegionSources("Zaporizhzhia", false),
  },
];

/* Kherson and Zaporizhzhia are not covered by Executive Order 14065.
   Donetsk and Luhansk are. The Canada and EU instruments cover all four,
   and all four carry the same whole-oblast note. */
function occupiedRegionSources(oblast: string, ofacOrder: boolean): SanctionSource[] {
  const sources: SanctionSource[] = [];
  if (ofacOrder) {
    sources.push({
      authority: "US-OFAC",
      instrument: "Executive Order 14065 (21 February 2022), as amended",
      url: OFAC_UKRAINE,
      asOf: "2026-05-08",
      note: `Comprehensive prohibition on the named occupied region of ${oblast}. Program page current on 2026-10-06. ${WHOLE_OBLAST}`,
    });
  }
  sources.push(
    {
      authority: "Canada-SEMA",
      instrument: "Special Economic Measures (Ukraine) Regulations, SOR/2014-60, section 4.2",
      url: CANADA_UKRAINE,
      asOf: "2026-09-21",
      note: `Occupied-region definition for ${oblast}, Justice Laws text current to 2026-09-21. ${WHOLE_OBLAST}`,
    },
    {
      authority: "EU",
      instrument: "Council Regulation (EU) 2022/263",
      url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R0263",
      asOf: "2026-10-06",
      note: `Restrictions on the named occupied region of ${oblast}. Overview: ${EU_UKRAINE_OVERVIEW}. ${WHOLE_OBLAST}`,
    },
  );
  return sources;
}

/* Exact match on the whole string. "Korea" is not North Korea.
   "DPR" is Donetsk. "DPRK" is North Korea. A substring search
   would get both wrong. Case, extra whitespace, and diacritics
   are ignored. Apostrophes are dropped so the official spelling
   and the spelling without one land on the same key. */
function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* Only on a region field, and only once. "Donetsk Oblast" is
   Donetsk. "Kherson Region", "Zaporizhzhia Province", and
   "Sevastopol City" follow the same rule. A country field keeps
   the suffix, so a country is not matched by trimming it. */
function stripRegionSuffix(normalized: string): string {
  return normalized.replace(/ (oblast|region|province|city)$/, "");
}

function compactCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const byName = new Map<string, SanctionedJurisdiction>();
const byCode = new Map<string, SanctionedJurisdiction>();
const byCurrency = new Map<string, SanctionedJurisdiction>();

function claim(map: Map<string, SanctionedJurisdiction>, key: string, entry: SanctionedJurisdiction): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing && existing.id !== entry.id) {
    throw new Error(`Sanctioned jurisdiction key "${key}" is claimed by ${existing.id} and ${entry.id}.`);
  }
  map.set(key, entry);
}

/* A bare two-letter token is an ISO country code and nothing else.
   It goes in the code index, which a country field consults.
   A region field does not, so a Pakistani region stored as KP is
   not North Korea. "NK" is not an alias for the same reason. */
function indexPlace(entry: SanctionedJurisdiction, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) return;
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    claim(byCode, trimmed.toUpperCase(), entry);
    return;
  }
  claim(byName, normalizeName(trimmed), entry);
  const compact = compactCode(trimmed);
  if (compact.length > 2) claim(byCode, compact, entry);
}

for (const entry of SANCTIONED_JURISDICTIONS) {
  if (entry.tier !== "blocked" && entry.tier !== "enhanced_due_diligence") {
    throw new Error(`${entry.id} has no tier.`);
  }
  if (entry.sources.length === 0) {
    throw new Error(`${entry.id} has no source.`);
  }
  for (const source of entry.sources) {
    if (!source.url.startsWith("https://") || !/^\d{4}-\d{2}-\d{2}$/.test(source.asOf)) {
      throw new Error(`${entry.id} has a source without an https URL and an as-of date.`);
    }
  }
  indexPlace(entry, entry.name);
  indexPlace(entry, entry.iso);
  for (const alias of entry.aliases) indexPlace(entry, alias);
  for (const currency of entry.currencies) {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`${entry.id} has a currency that is not an ISO code: ${currency}`);
    }
    claim(byCurrency, currency, entry);
  }
}

export function lookupSanctionedJurisdiction(
  value: string | null | undefined,
  field: PlaceField = "country",
): SanctionedJurisdiction | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const name = field === "region" ? stripRegionSuffix(normalizeName(raw)) : normalizeName(raw);
  const named = name ? byName.get(name) : undefined;
  if (named) return named;
  const code = compactCode(raw);
  if (!code) return null;
  if (field === "region" && code.length === 2) return null;
  return byCode.get(code) ?? null;
}

export function lookupSanctionedCurrency(code: string | null | undefined): SanctionedJurisdiction | null {
  if (code == null) return null;
  const compact = String(code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(compact)) return null;
  return byCurrency.get(compact) ?? null;
}

/* True only for the blocked tier. Myanmar is on the list and is
   not a block. A region field never treats a two-letter code as a hit. */
export function isSanctionedJurisdiction(
  value: string | null | undefined,
  field: PlaceField = "country",
): boolean {
  return lookupSanctionedJurisdiction(value, field)?.tier === "blocked";
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function blockedPlace(value: string | null, field: PlaceField): SanctionedJurisdiction | null {
  const hit = lookupSanctionedJurisdiction(value, field);
  if (!hit || hit.tier !== "blocked") return null;
  return hit;
}

/* The country fields a signup or a setup save can name a place in.
   "XX" and "Somewhere else" are not countries. The free-text
   elseCountry is. A region is read as a region, so a two-letter
   code in that box is not a country. */
const DESK_COUNTRY_FIELDS = ["country", "elseCountry", "country_addr"] as const;

export function blockedDeskCountry(answers: Record<string, unknown> | null | undefined): SanctionedJurisdiction | null {
  if (!answers) return null;
  for (const key of DESK_COUNTRY_FIELDS) {
    const hit = blockedPlace(text(answers[key]), "country");
    if (hit) return hit;
  }
  const region = blockedPlace(text(answers.region), "region");
  if (region) return region;
  const address = answers.address;
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const place = address as Record<string, unknown>;
    return blockedPlace(text(place.country), "country")
      ?? blockedPlace(text(place.region), "region");
  }
  return null;
}

function openMessage(entry: SanctionedJurisdiction): string {
  return `${entry.name} is on the sanctions list. A desk cannot be opened there.`;
}

function countryMessage(entry: SanctionedJurisdiction): string {
  return `${entry.name} is on the sanctions list. This desk cannot set its country to ${entry.name}.`;
}

export function signupRefusal(entry: SanctionedJurisdiction): { error: "sanctioned_country"; detail: string } {
  return { error: "sanctioned_country", detail: openMessage(entry) };
}

export function countryChangeRefusal(entry: SanctionedJurisdiction): { error: "sanctioned_country"; detail: string } {
  return { error: "sanctioned_country", detail: countryMessage(entry) };
}

export function transferRefusal(
  entry: SanctionedJurisdiction,
  direction: "send" | "receive",
): { code: "SANCTIONED_JURISDICTION"; message: string } {
  const verb = direction === "send" ? "sent to" : "received from";
  return {
    code: "SANCTIONED_JURISDICTION",
    message: `This transfer cannot be ${verb} ${entry.name}. ${entry.name} is on the sanctions list.`,
  };
}

function currencyRefusal(
  entry: SanctionedJurisdiction,
  currency: string,
  direction: "send" | "receive",
): { code: "SANCTIONED_JURISDICTION"; message: string } {
  const verb = direction === "send" ? "pay out" : "be received in";
  return {
    code: "SANCTIONED_JURISDICTION",
    message: `This transfer cannot ${verb} ${currency}. ${entry.name} is on the sanctions list.`,
  };
}

export function missingCorridorMessage(direction: "send" | "receive"): string {
  return direction === "send"
    ? "Name the destination country before this transfer can be sent."
    : "Name the source country before this transfer can be received.";
}

function dealMessage(entry: SanctionedJurisdiction): string {
  return `This deal is stopped. The client is in ${entry.name}, which is on the sanctions list. Report it under ${SANCTIONS_STOP_CODE}.`;
}

export function enhancedDueDiligenceGap(
  entry: SanctionedJurisdiction,
  idStatus: string | null | undefined,
  purpose: string | null | undefined,
  sourceOfFunds: string | null | undefined,
): { code: "COMPLIANCE_BLOCKED"; message: string } | null {
  const identified = idStatus === "verified";
  const noted = !!purpose?.trim() && !!sourceOfFunds?.trim();
  if (identified && noted) return null;
  return {
    code: "COMPLIANCE_BLOCKED",
    message: `This deal touches ${entry.name}, which needs enhanced due diligence. Identify the client in full, and add a short reason and source of funds, before it can post.`,
  };
}

/* Thrown by provisionDesk so both doors that create a desk refuse
   even if a route forgot to check. Routes catch it and answer 403.
   Only the blocked tier throws this. */
export class SanctionedCountryError extends Error {
  readonly error = "sanctioned_country" as const;
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "SanctionedCountryError";
    this.detail = detail;
  }
}

export type SanctionsStopAudit = {
  jurisdictionId: string;
  jurisdictionName: string;
  listVersion: string;
  dealKind: string;
  direction: "send" | "receive" | null;
  corridor: string | null;
  currency: string | null;
  customerId: string;
  blocked: "corridor" | "currency" | "client";
};

export type DealScreen =
  | { outcome: "clear" }
  | { outcome: "invalid"; code: "INVALID_REQUEST"; message: string }
  | { outcome: "stop"; code: string; message: string; audit: SanctionsStopAudit }
  | { outcome: "enhanced_due_diligence"; entry: SanctionedJurisdiction };

/* Written on the pool, after the deal transaction has rolled back.
   The rolled-back transaction cannot hold this row or the stop
   would vanish with it. A failure here is swallowed: the teller
   still gets the stop, not a server error. */
export async function recordSanctionsStop(
  pool: pg.Pool,
  actor: {
    userId: string;
    tenantId: string;
    legalEntityId: string;
    branchId: string;
    workspaceId: string;
    tillId: string;
  },
  error: unknown,
): Promise<void> {
  const audit = error && typeof error === "object"
    ? (error as { sanctionsAudit?: SanctionsStopAudit }).sanctionsAudit
    : undefined;
  if (!audit) return;
  try {
    await pool.query(
      `INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail)
       VALUES ($1, $2, $3, $4, $5, 'sanctions.stop', $6::jsonb)`,
      [
        randomUUID(),
        actor.tenantId,
        actor.legalEntityId,
        actor.branchId,
        actor.userId,
        JSON.stringify({
          ...audit,
          workspaceId: actor.workspaceId,
          tillId: actor.tillId,
        }),
      ],
    );
  } catch {
    /* The deal is already refused. Losing the audit row is worse
       than the teller seeing it, and turning the refusal into a
       500 would hide the reason. */
  }
}

function placeHit(value: unknown, field: PlaceField): SanctionedJurisdiction | null {
  return lookupSanctionedJurisdiction(text(value), field);
}

/* Corridor first, then the payout or sent currency, then the client.
   A blocked hit wins over enhanced due diligence, so an Iranian
   client sending to Myanmar is a stop, not a diligence note.
   A missing corridor is a validation error and is not audited.
   A walk-in with no client record has no country to read, so the
   corridor and the currency are what can stop that deal. Returned
   as data so this module does not import the ledger's error type. */
export async function screenDeal(
  client: pg.PoolClient,
  scope: { tenantId: string; legalEntityId: string },
  input: {
    customerId: string;
    dealKind: string;
    corridor?: string | null;
    currency?: string | null;
    transfer?: "send" | "receive" | null;
  },
): Promise<DealScreen> {
  const transfer = input.transfer === "send" || input.transfer === "receive" ? input.transfer : null;
  const corridor = text(input.corridor);
  const currency = text(input.currency)?.toUpperCase() ?? null;
  let diligence: SanctionedJurisdiction | null = null;

  const stop = (
    entry: SanctionedJurisdiction,
    code: string,
    message: string,
    blocked: SanctionsStopAudit["blocked"],
    stoppedCurrency: string | null,
  ): DealScreen => ({
    outcome: "stop",
    code,
    message,
    audit: {
      jurisdictionId: entry.id,
      jurisdictionName: entry.name,
      listVersion: SANCTIONS_LIST_VERSION,
      dealKind: input.dealKind,
      direction: transfer,
      corridor,
      currency: stoppedCurrency,
      customerId: input.customerId,
      blocked,
    },
  });

  const watch = (hit: SanctionedJurisdiction | null): DealScreen | null => {
    if (!hit) return null;
    if (hit.tier === "blocked") return null;
    if (!diligence) diligence = hit;
    return null;
  };

  if (transfer) {
    if (!corridor) {
      return { outcome: "invalid", code: "INVALID_REQUEST", message: missingCorridorMessage(transfer) };
    }
    const corridorHit = lookupSanctionedJurisdiction(corridor, "country");
    if (corridorHit?.tier === "blocked") {
      const refusal = transferRefusal(corridorHit, transfer);
      return stop(corridorHit, refusal.code, refusal.message, "corridor", currency);
    }
    watch(corridorHit);
  }

  if (currency && transfer) {
    const currencyHit = lookupSanctionedCurrency(currency);
    if (currencyHit?.tier === "blocked") {
      const refusal = currencyRefusal(currencyHit, currency, transfer);
      return stop(currencyHit, refusal.code, refusal.message, "currency", currency);
    }
    watch(currencyHit ?? null);
  }

  const found = await client.query(
    `SELECT c.country, c.region, c.incorporation_jurisdiction
       FROM ledger_customers lc
       JOIN desk_clients c
         ON c.client_id = lc.client_id
        AND c.tenant_id = lc.tenant_id
        AND c.legal_entity_id = lc.legal_entity_id
      WHERE lc.customer_id = $1
        AND lc.tenant_id = $2
        AND lc.legal_entity_id = $3`,
    [input.customerId, scope.tenantId, scope.legalEntityId],
  );
  const row = found.rows[0];
  if (row) {
    const clientHit = placeHit(row.country, "country")
      ?? placeHit(row.region, "region")
      ?? placeHit(row.incorporation_jurisdiction, "country")
      ?? placeHit(row.incorporation_jurisdiction, "region");
    if (clientHit?.tier === "blocked") {
      return stop(clientHit, SANCTIONS_STOP_CODE, dealMessage(clientHit), "client", currency);
    }
    watch(clientHit);
  }

  if (diligence) return { outcome: "enhanced_due_diligence", entry: diligence };
  return { outcome: "clear" };
}
