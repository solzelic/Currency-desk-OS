/* ============================================================
   Sanctioned jurisdictions.

   One list, in the repo, so a desk, a transfer, and a deal all
   refuse the same places. The browser does not keep a copy.
   Other features call lookupSanctionedJurisdiction or
   lookupSanctionedCurrency. They do not restate the list.

   What is on the list: comprehensive country-wide programs under
   the UN, Canada (SEMA), the EU, and US OFAC, plus the FATF
   "call for action" blacklist. A program that names people,
   entities, or a sector, and leaves the rest of the country
   open, is not on this list.

   What is not a country: Crimea, Donetsk, Luhansk, Kherson, and
   Zaporizhzhia. Those are regions of Ukraine. Ukraine itself is
   not sanctioned. A transfer corridor is an ISO alpha-2 code, so
   it cannot name a region. A corridor of UA is allowed. A client
   whose region or incorporation jurisdiction names one of those
   regions is stopped.

   How to refresh it: docs/SANCTIONED_JURISDICTIONS.md.
   Bump SANCTIONS_LIST_VERSION and the as-of date on every entry
   you re-check. Do not edit a merged migration to change this list.
   ============================================================ */
import type pg from "pg";

export const SANCTIONS_LIST_VERSION = "2026-10-06.1";
export const SANCTIONS_LIST_CHECKED = "2026-10-06";

export type SanctionAuthority = "UN" | "Canada-SEMA" | "EU" | "US-OFAC" | "FATF";

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

/* Checked against the official pages on SANCTIONS_LIST_CHECKED.
   Left off on purpose, and why, is written in
   docs/SANCTIONED_JURISDICTIONS.md: Syria (comprehensive programs
   terminated), Russia, Belarus, Venezuela, list-based UN regimes,
   the FATF increased-monitoring list, and Canada's list-based
   Iran regulations. */
export const SANCTIONED_JURISDICTIONS: readonly SanctionedJurisdiction[] = [
  {
    id: "CU",
    kind: "country",
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
        note: "Program page current on 2026-10-06. Comprehensive. Not a Canada, EU, UN, or FATF country-wide program.",
      },
    ],
  },
  {
    id: "IR",
    kind: "country",
    name: "Iran",
    iso: "IR",
    parentCountry: null,
    currencies: ["IRR"],
    aliases: ["Iran", "Islamic Republic of Iran", "IR"],
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
    name: "North Korea",
    iso: "KP",
    parentCountry: null,
    currencies: ["KPW"],
    aliases: [
      "North Korea",
      "DPRK",
      "NK",
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
    name: "Myanmar",
    iso: "MM",
    parentCountry: null,
    currencies: ["MMK"],
    aliases: ["Myanmar", "Burma", "Republic of the Union of Myanmar", "MM"],
    sources: [
      {
        authority: "FATF",
        instrument: "High-risk jurisdictions subject to a call for action, June 2026 (enhanced due diligence)",
        url: FATF_CALL,
        asOf: "2026-06-19",
        note: "On the call-for-action blacklist. FATF asked members to apply enhanced due diligence, and to consider countermeasures if there is no progress by the October 2026 plenary. That plenary had not published on 2026-10-06. Not an OFAC comprehensive program, and not a Canada country-wide ban.",
      },
    ],
  },
  {
    id: "UA-43",
    kind: "region",
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
    name: "Donetsk",
    iso: "UA-14",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Donetsk", "Donetsk People's Republic", "DNR", "DPR", "UA-14", "UA14"],
    sources: occupiedRegionSources("Donetsk"),
  },
  {
    id: "UA-09",
    kind: "region",
    name: "Luhansk",
    iso: "UA-09",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Luhansk", "Lugansk", "Luhansk People's Republic", "LNR", "UA-09", "UA09"],
    sources: occupiedRegionSources("Luhansk"),
  },
  {
    id: "UA-65",
    kind: "region",
    name: "Kherson",
    iso: "UA-65",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Kherson", "UA-65", "UA65"],
    sources: occupiedRegionSources("Kherson"),
  },
  {
    id: "UA-23",
    kind: "region",
    name: "Zaporizhzhia",
    iso: "UA-23",
    parentCountry: "UA",
    currencies: [],
    aliases: ["Zaporizhzhia", "Zaporizhia", "Zaporozhye", "UA-23", "UA23"],
    sources: occupiedRegionSources("Zaporizhzhia"),
  },
];

function occupiedRegionSources(oblast: string): SanctionSource[] {
  const partial = oblast === "Kherson" || oblast === "Zaporizhzhia"
    ? ` The measure covers the occupied part of ${oblast} oblast, not the government-controlled part. Matching the oblast name over-includes the government-controlled area, because this list cannot see which side of the line an address is on.`
    : "";
  return [
    {
      authority: "US-OFAC",
      instrument: "Executive Order 14065 (21 February 2022), as amended",
      url: OFAC_UKRAINE,
      asOf: "2026-05-08",
      note: `Comprehensive prohibition on the named occupied region. Program page current on 2026-10-06.${partial}`,
    },
    {
      authority: "Canada-SEMA",
      instrument: "Special Economic Measures (Ukraine) Regulations, SOR/2014-60, section 4.2",
      url: CANADA_UKRAINE,
      asOf: "2026-09-21",
      note: `Occupied-region definition, Justice Laws text current to 2026-09-21.${partial}`,
    },
    {
      authority: "EU",
      instrument: "Council Regulation (EU) 2022/263",
      url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R0263",
      asOf: "2026-10-06",
      note: `Restrictions on the named occupied region. Overview: ${EU_UKRAINE_OVERVIEW}.${partial}`,
    },
  ];
}

/* Exact match only. "Korea" is not North Korea. "DPR" is Donetsk.
   "DPRK" is North Korea. A substring search would get both wrong. */
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

for (const entry of SANCTIONED_JURISDICTIONS) {
  if (entry.sources.length === 0) {
    throw new Error(`${entry.id} has no source.`);
  }
  for (const source of entry.sources) {
    if (!source.url.startsWith("https://") || !/^\d{4}-\d{2}-\d{2}$/.test(source.asOf)) {
      throw new Error(`${entry.id} has a source without an https URL and an as-of date.`);
    }
  }
  claim(byName, normalizeName(entry.name), entry);
  claim(byCode, compactCode(entry.iso), entry);
  for (const alias of entry.aliases) {
    claim(byName, normalizeName(alias), entry);
    claim(byCode, compactCode(alias), entry);
  }
  for (const currency of entry.currencies) {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error(`${entry.id} has a currency that is not an ISO code: ${currency}`);
    }
    claim(byCurrency, currency, entry);
  }
}

export function lookupSanctionedJurisdiction(value: string | null | undefined): SanctionedJurisdiction | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return byName.get(normalizeName(raw)) ?? byCode.get(compactCode(raw)) ?? null;
}

export function lookupSanctionedCurrency(code: string | null | undefined): SanctionedJurisdiction | null {
  if (code == null) return null;
  const compact = String(code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(compact)) return null;
  return byCurrency.get(compact) ?? null;
}

export function isSanctionedJurisdiction(value: string | null | undefined): boolean {
  return lookupSanctionedJurisdiction(value) !== null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/* The country fields a signup or a setup save can name a place in.
   "XX" and "Somewhere else" are not countries. The free-text
   elseCountry is, and so is a region when the list has that region. */
const DESK_PLACE_FIELDS = ["country", "elseCountry", "country_addr", "region"] as const;

export function blockedDeskCountry(answers: Record<string, unknown> | null | undefined): SanctionedJurisdiction | null {
  if (!answers) return null;
  for (const key of DESK_PLACE_FIELDS) {
    const hit = lookupSanctionedJurisdiction(text(answers[key]));
    if (hit) return hit;
  }
  const address = answers.address;
  if (address && typeof address === "object" && !Array.isArray(address)) {
    const place = address as Record<string, unknown>;
    return lookupSanctionedJurisdiction(text(place.country))
      ?? lookupSanctionedJurisdiction(text(place.region));
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

function dealMessage(entry: SanctionedJurisdiction, code: string): string {
  return `This deal is stopped. The client is in ${entry.name}, which is on the sanctions list. Report it under ${code}.`;
}

/* Thrown by provisionDesk so both doors that create a desk refuse
   even if a route forgot to check. Routes catch it and answer 403. */
export class SanctionedCountryError extends Error {
  readonly error = "sanctioned_country" as const;
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "SanctionedCountryError";
    this.detail = detail;
  }
}

async function sanctionsStopCode(client: pg.PoolClient, packId: string): Promise<string> {
  const found = await client.query(
    `SELECT code
       FROM jurisdiction_reports
      WHERE pack_id = $1
        AND coalesce(format_rules, '{}'::jsonb) @> '{"sanctionsStop": true}'::jsonb
      ORDER BY code
      LIMIT 1`,
    [packId],
  );
  const code = found.rows[0]?.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  /* A pack with no flagged row still stops the deal. The baseline
     code is the one every pack can say until it names its own. */
  return "SANCTIONS-STOP";
}

/* Corridor first, then the client. A send to a listed country is a
   transfer block, including when the client is listed as well.
   A walk-in with no client record has no country to read, so only
   the corridor can stop that deal. Returned as data so this module
   does not import the ledger's error type. */
export async function dealSanctionsStop(
  client: pg.PoolClient,
  scope: { tenantId: string; legalEntityId: string },
  packId: string,
  input: {
    customerId: string;
    corridor?: string | null;
    transfer?: "send" | "receive" | null;
  },
): Promise<{ code: string; message: string } | null> {
  if (input.transfer === "send" || input.transfer === "receive") {
    const corridor = lookupSanctionedJurisdiction(input.corridor);
    if (corridor) return transferRefusal(corridor, input.transfer);
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
  if (!row) return null;
  const hit = lookupSanctionedJurisdiction(row.country)
    ?? lookupSanctionedJurisdiction(row.region)
    ?? lookupSanctionedJurisdiction(row.incorporation_jurisdiction);
  if (!hit) return null;
  const code = await sanctionsStopCode(client, packId);
  return { code, message: dealMessage(hit, code) };
}
