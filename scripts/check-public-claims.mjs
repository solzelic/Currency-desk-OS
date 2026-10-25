#!/usr/bin/env node
/* Fails if a served public page repeats a claim the live product does
   not make. Tags are stripped, entities decoded, whitespace collapsed
   and the text lowercased before a match, so a tag, a line break or
   a non-breaking space cannot hide a phrase. A soft hyphen or a
   zero-width character is read twice: deleted, so it cannot split a
   word, and replaced with a space, so it cannot hide a gap. A phrase
   on any reading fails. Timing phrases are included: a visit in
   seconds, a count of minutes, an N-minute compound, the same
   afternoon or day (including same-day), a fortnight, about a week,
   within a week, within N hours, in N hours, 48h, Nh, N hrs, under
   N hours, replying today, 24/7, real-time, and live rates.

   Every dash variant (U+2010, U+2011, U+2012 to U+2015, U+2212,
   fullwidth and small hyphens, and the named en dash, em dash,
   minus, and hyphen) folds to an ASCII hyphen. A thin space is a
   space. A phrase on any reading fails. Meta content is read when
   it is quoted or unquoted, and leftover words in the tag are kept.
   A tag inside a word is read again with the tag deleted, so it
   cannot split the word.

   "Live rate board" is the Rates plan's name. That exact phrase is
   allowed. "live rates" anywhere else, including a hyphen and a meta
   description, still fails. "updated every second" still fails
   beside the name. A sentence that says the board moves with the
   market still fails. The plural "live rate boards" is not the name.
   "handling real work", "see it live", "live board", "always current",
   "plenty of shops", "48-hour", "less than an hour", and "overnight"
   fail. The product-name exception is removed before those checks.

   A regulator deadline is allowed only on the compliance and FAQ
   pages, and only when the allowed clause is the whole clause.
   The only clause that suppresses a banned pattern is "SMR within
   24 hours for terrorism financing". A longer sentence that merely
   contains those words does not pass. Deadlines in days do not
   match a banned pattern, so they are not listed. US CTR and SAR
   phrases are not listed. "within 3 business days" is not a
   banned pattern. A cash total that starts at midnight, resets at
   midnight, or uses a static or calendar-day window is banned on
   every served page. "does not reset at midnight" and "never resets
   at midnight" stay, because they deny that reset. Those two
   denials are blanked before the match, and any other midnight,
   including "mid-night", fails. "15 calendar days" stays, because
   it is a filing deadline. A singular "calendar day" fails. "each
   day" fails when reset, aggregation, added, or total sits within
   80 characters. "12:00 am", "12:00am", "12 am", "12am", and
   "12:00 a.m." fail. The cash total is the rolling 24 hours before
   each deal.

   The same window claims are read from the in-app help: every
   file in os-src and web/app/os.js. Comments are removed first,
   so a note about the branch clock is not a help sentence. Tags
   are left in place, so a sentence inside a JSX attribute is still
   read. The other marketing bans are not applied to those files.
   The desk itself says minutes, hours, and sanctions screening.

   A claim this pass removed is banned as a phrase, so it cannot
   return. "AI assistant" is allowed only in the honest sentence
   that it is coming soon and not included yet, or that it is not
   connected. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const files = [
  "web/index.html",
  "web/mobile.html",
  "web/compliance.html",
  "web/faq.html",
  "web/early-access.html",
  "web/legal.html",
  "web/contact.html",
  "web/onboarding.html",
];

const phrases = [
  [/ofac/, "OFAC"],
  [/un sanctions/, "UN sanctions"],
  [/\bosfi\b/, "OSFI"],
  [/desks claimed/, "desks claimed"],
  [/report ready/, "Report ready"],
  [/then deleted/, "then deleted"],
  [/encrypted at rest/, "encrypted at rest"],
  [/encryption at rest/, "encryption at rest"],
  [/in the region you operate/, "in the region you operate"],
  [/real shops?/, "real shop"],
  [/billed per file/, "billed per file"],
  [/billed separately/, "billed separately"],
  [/identity verification/, "identity verification"],
  [/error monitoring/, "error monitoring"],
  [/measured at the counter/, "measured at the counter"],
  [/first shop/, "first shop"],
  [/screened against/, "screened against"],
  [/most popular/, "most popular"],
  [/most chosen/, "most chosen"],
  [/\bun list\b/, "UN list"],
  [/united nations list/, "United Nations list"],
  [/best protection/, "best protection"],
  [/\bin seconds\b/, "in seconds"],
  [/\bin (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety) seconds?\b/, "in N seconds"],
  [/\bin (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety) minutes?\b/, "in N minutes"],
  [/\b(?:\d+|a few|few|several|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety) minutes?\b/, "minutes"],
  [/\b(?:\d+|two|five|ten|fifteen|twenty|thirty|sixty|ninety) seconds\b/, "N seconds"],
  [/\bsame afternoon\b/, "same afternoon"],
  [/\bsame day\b/, "same day"],
  [/\bsame-day\b/, "same-day"],
  [/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)-minutes?\b/, "N-minute"],
  [/\bfortnights?\b/, "fortnight"],
  [/\b24\s*\/\s*7\b/, "24/7"],
  [/\breal[-\s]time\b/, "real-time"],
  [/\blive[-\s]rates\b/, "live rates"],
  [/handling real work/, "handling real work"],
  [/see it live/, "see it live"],
  [/\blive board\b/, "live board"],
  [/\b48-hours?\b/, "48-hour"],
  [/\b(?:2|48) hours?\b/, "N hour"],
  [/\b\d{1,3}-hours?\b/, "N-hour"],
  [/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)-hours?\b/, "two-hour"],
  [/\bwithin the hour\b/, "within the hour"],
  [/\bnext[-\s]days?\b/, "next-day"],
  [/\breply today\b/, "reply today"],
  [/\breplies today\b/, "replies today"],
  [/\blive rate boards\b/, "live rate boards"],
  [/\bas the market moves\b/, "as the market moves"],
  [/\bless than (?:an|a|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety|\d+) hours?\b/, "less than an hour"],
  [/\bover-?nights?\b/, "overnight"],
  [/\bevery second\b/, "every second"],
  [/plenty of shops/, "plenty of shops"],
  [/\balways current\b/, "always current"],
  [/\breplying today\b/, "replying today"],
  [/\babout a week\b/, "about a week"],
  [/\bwithin a week\b/, "within a week"],
  [/the desk tells you when that is/, "the desk tells you when that is"],
  [/small walk-in exchange is not the same/, "small walk-in exchange"],
  [/being able to show declines/, "show declines"],
  [/the desk carries the rules with you/, "the desk carries the rules with you"],
  [/same screens, different thresholds/, "same screens, different thresholds"],
  [/nine things on the desk today/, "nine things on the desk today"],
  [/the next nine will come/, "the next nine will come"],
  [/only you and the staff you name/, "only you and the staff you name"],
  [/as a custodian, not an owner/, "custodian, not an owner"],
  [/people you nominate/, "people you nominate"],
  [/messages you send clients through the desk/, "messages you send clients"],
  [/need it to do their job and is logged/, "and is logged"],
  [/without anyone managing it/, "without anyone managing it"],
  [/five-year-old ticket/, "five-year-old ticket"],
  [/not a reportable event/, "not a reportable event"],
  [/your public board, clients and your ledger anywhere/, "ledger anywhere"],
  [/standard formats your accountant/, "standard formats your accountant"],
  [/full export, not a locked door/, "full export, not a locked door"],
  [/shared view across them/, "shared view across them"],
  [/keeps you trading through an outage/, "trading through an outage"],
  [/maps your regulator/, "maps your regulator"],
  [/your registration decides which obligations/, "your registration decides"],
  [/four steps run in every jurisdiction/, "four steps in every jurisdiction"],
  [/we read your licen[cs]e/, "we read your licence"],
  [/good for a year/, "good for a year"],
  [/deep file behind the badge/, "deep file behind the badge"],
  [/maintained with the desk/, "maintained with the desk"],
  [/maintained to the cbuae/, "maintained to the CBUAE"],
  [/kept in line with the amlo/, "kept in line with the AMLO"],
  [/support analytics and can be declined/, "support analytics"],
  [/mapped for nine more/, "mapped for nine more"],
  [/straight answer/, "straight answer"],
  [/watches the numbers with you/, "watches the numbers with you"],
  [/copilot that watches your numbers/, "copilot that watches your numbers"],
  [/not a spreadsheet/, "not a spreadsheet"],
  [/spots patterns you would never/, "spots patterns"],
  [/short daily read/, "short daily read"],
  [/we rely on are render/, "we rely on are Render"],
  [/the database is neon\b/, "the database is Neon"],
  [/listed in the pack\. a licence class is not tracked/, "listed in the pack, licence class"],
  [/listed in the pack\. a licence is not tracked/, "listed in the pack, licence"],
  [/due diligence at hk\$120,000/, "due diligence at HK$120,000"],
  [/occasional-transaction threshold/, "occasional-transaction threshold"],
  [/if you need everything at once, ask us/, "If you need everything at once, ask us"],
  [/6-year records/, "6-year records"],
  [/c&ed licensed/, "C&ED licensed"],
  [/ps act class/, "PS Act class"],
  [/we rely on our contracts with these providers/, "we rely on our contracts"],
  [/retained for the statutory retention period that applies/, "retained for the statutory retention period"],
  [/the desk records what happened/, "the desk records what happened"],
  [/cbuae rulebook/, "CBUAE rulebook"],
  [/clients & kyc/, "Clients & KYC"],
  [/rulebook loads first/, "rulebook loads first"],
  [/texting is not connected yet\. the desk does not send a message/, "Texting is not connected yet. The desk does not send a message."],
  [/texting is not connected, so the desk does not send messages to your clients/, "Texting is not connected, so the desk does not send messages"],
  [/the desk does not draft or send a suspicious transaction report/, "does not draft or send a suspicious transaction report"],
  [/shared view across several locations is not built yet/, "shared view across several locations"],
  [/not drafted or sent/, "Not drafted or sent"], [/can i text clients without giving out my number/, "Can I text clients without giving out my number?"], [/ready for pickup/, "ready for pickup"],
  [/midnight in the branch time zone/, "midnight in the branch time zone"],
  [/starts at midnight/, "starts at midnight"],
  [/from midnight/, "from midnight"],
  [/static 24 hours/, "static 24 hours"],
  [/static window/, "static window"],
  [/not a rolling day/, "not a rolling day"],
  [/calendar-?day window/, "calendar-day window"],
  [/(?<!\b(?:does not|never) )reset(?:s)? at midnight/, "resets at midnight"],
  [/\bcalendar day\b/, "calendar day"],
  [/\bmid[\s-]?night\b/, "midnight"],
  [/\b12(?::00)?\s*am\b/, "12:00 am"],
];

const HOUR_WORD = "(?:\\d+|an|a|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)";
const HOURS = new RegExp(`\\b(?:within|in) ${HOUR_WORD} hours?\\b`, "g");
const UNDER_HOURS = new RegExp(`\\bunder ${HOUR_WORD} hours?\\b`, "g");
/* A digit run inside a font or image blob can end in h. A real
   "48h" is not glued to that alphabet. */
const NH = /(?<![a-z0-9+/=])\d{1,3}\s*h\b/g;
const NHRS = new RegExp(`\\b(?:\\d+|${HOUR_WORD}) hrs?\\b`, "g");

/* Clauses that contain a banned pattern and are cited as a whole
   clause on the compliance and FAQ pages. Blanked only there, and
   only when punctuation bounds the clause. */
const REGULATOR_PAGES = new Set(["web/compliance.html", "web/faq.html"]);
const REGULATOR_CLAUSES = [
  "smr within 24 hours for terrorism financing, otherwise 3 business days",
  "smr within 24 hours for terrorism financing",
];
/* A comma does not end the clause, so ", guaranteed" cannot borrow it.
   A closing quote does: the deadline is a script string. */
const CLAUSE_BEFORE = "(?:^|[.!?;:\\u00b7\\n])";
const CLAUSE_AFTER = "(?=$|[.!?;:\\u00b7\\n'\"])";
/* The FINTRAC window name. Anything else with 24-hour still fails. */
const HOUR_RULES = [
  "24-hour aggregation rule",
  "24-hour rule",
];

function normalize(html, invisible, tags = " ", options = {}) {
  const stripTags = options.stripTags !== false;
  let text = String(html);
  const decodeNumeric = (value) =>
    value
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  text = decodeNumeric(text);
  const named = {
    nbsp: " ",
    shy: invisible,
    zwnj: invisible,
    zwj: invisible,
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    ndash: "-",
    mdash: "-",
    minus: "-",
    hyphen: "-",
    dash: "-",
    thinsp: " ",
    ensp: " ",
    emsp: " ",
    hairsp: " ",
  };
  text = text.replace(/&([a-z]+);/gi, (all, name) =>
    Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : all,
  );
  /* A second pass catches &amp;nbsp; and &amp;shy; once the amp is decoded. */
  text = decodeNumeric(text);
  text = text.replace(/&(?:shy|zwnj|zwj);/gi, invisible);
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/[\u2002\u2003\u2009\u200A\u202F]/g, " ");
  text = text.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D\u2E3A\u2E3B]/g, "-");
  text = text.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, invisible);
  if (stripTags) {
    text = text.replace(/<meta\b[^>]*>/gi, readMeta);
    text = text.replace(/<[^>]*>/g, tags);
  }
  text = text.replace(/\s+/g, " ").trim().toLowerCase();
  /* O.F.A.C. and U.N. become ofac and un before the phrase match. */
  text = text.replace(/(?:[a-z]\.){2,}[a-z]?/g, (match) => match.replace(/\./g, ""));
  return text;
}

function readMeta(tag) {
  const values = [];
  const attrs = /\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  const rest = tag.replace(/<\/?meta\b/i, " ").replace(/>/g, " ").replace(attrs, (_, name, dq, sq, uq) => {
    if (String(name).toLowerCase() === "content") values.push(dq ?? sq ?? uq ?? "");
    return " ";
  });
  return ` ${values.join(" ")} ${rest} `;
}

export function visibleText(html) {
  return normalize(html, "");
}

function nearby(text, needle, other, span) {
  const hits = [];
  const re = new RegExp(`\\b${needle}\\b`, "g");
  const otherRe = new RegExp(`\\b${other}\\b`);
  let match;
  while ((match = re.exec(text))) {
    const from = Math.max(0, match.index - span);
    const to = Math.min(text.length, match.index + match[0].length + span);
    const slice = text.slice(from, to);
    if (otherRe.test(slice)) hits.push(slice.slice(0, 220));
  }
  return hits;
}

function withoutAllowed(text, rel) {
  let scanned = text.replace(/\blive rate board\b/g, " ").replaceAll("held for 30 minutes", " ");
  for (const name of HOUR_RULES) scanned = scanned.replaceAll(name, " ");
  /* Blank the denials first. A later midnight pattern then sees only
     a claim that the total does reset. */
  scanned = scanned
    .replace(/\bdoes not reset at midnight\b/g, " ")
    .replace(/\bnever resets at midnight\b/g, " ")
    .replace(/\bnever reset at midnight\b/g, " ");
  if (!REGULATOR_PAGES.has(rel)) return scanned;
  for (const phrase of REGULATOR_CLAUSES) {
    const re = new RegExp(`${CLAUSE_BEFORE}\\s*${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${CLAUSE_AFTER}`, "g");
    scanned = scanned.replace(re, " ");
  }
  return scanned;
}

function claimPattern(re, text, label, problems) {
  re.lastIndex = 0;
  if (re.test(text)) problems.push(label);
  re.lastIndex = 0;
}

function claimsIn(text, problems, rel) {
  const scanned = withoutAllowed(text, rel);
  for (const [re, label] of phrases) claimPattern(re, scanned, label, problems);
  HOURS.lastIndex = 0;
  let hoursMatch;
  while ((hoursMatch = HOURS.exec(scanned))) {
    problems.push(hoursMatch[0].startsWith("within") ? "within N hours" : "in N hours");
  }
  HOURS.lastIndex = 0;
  claimPattern(UNDER_HOURS, scanned, "under N hours", problems);
  claimPattern(NH, scanned, "Nh", problems);
  claimPattern(NHRS, scanned, "N hrs", problems);
  /* "sanctions screening is not connected" is the honest sentence.
     Any other "sanctions screening" is a claim that a screen exists. */
  const screening = /sanctions screening/g;
  let screeningMatch;
  while ((screeningMatch = screening.exec(text))) {
    const after = text.slice(screeningMatch.index + screeningMatch[0].length);
    if (/^\s*is not connected/.test(after)) continue;
    problems.push("sanctions screening");
  }
  /* "The AI assistant is coming soon, not included yet" and
     "The AI assistant is not connected" are the honest sentences.
     A bare "AI assistant" in a feature list is a claim that it ships.
     Onboarding still names the assistant. That page is outside this
     pass, so the ban applies to every other served page. */
  if (rel !== "web/onboarding.html") {
    const assistant = /ai assistant/g;
    let assistantMatch;
    while ((assistantMatch = assistant.exec(text))) {
      const after = text.slice(assistantMatch.index + assistantMatch[0].length);
      if (/^\s+is coming soon, not included yet/.test(after)) continue;
      if (/^\s+is not connected/.test(after)) continue;
      problems.push("AI assistant");
    }
  }
  for (const match of scanned.matchAll(/\beach day\b/g)) {
    const from = Math.max(0, match.index - 80);
    const to = Math.min(scanned.length, match.index + match[0].length + 80);
    if (/\b(?:resets?|aggregat\w*|added|totals?)\b/.test(scanned.slice(from, to))) problems.push("each day");
  }
  for (const hit of nearby(text, "eftr", "live", 80)) {
    problems.push(`EFTR next to Live (${hit})`);
  }
  for (const hit of nearby(text, "str", "live", 80)) {
    problems.push(`STR next to Live (${hit})`);
  }
}

export function findClaims(html, rel = "") {
  const readings = [];
  for (const invisible of ["", " "]) {
    for (const tags of [" ", ""]) {
      const text = normalize(html, invisible, tags);
      if (!readings.includes(text)) readings.push(text);
    }
  }
  const problems = [];
  const deleted = normalize(html, "", " ");
  const spaced = normalize(html, " ", " ");
  /* "sanc&shy;tions" joins to "sanctions" only when the mark is
     deleted. A page that writes the word normally is left alone. */
  if (deleted.includes("sanctions") && !spaced.includes("sanctions")) problems.push("sanctions");
  for (const text of readings) claimsIn(text, problems, rel);
  return [...new Set(problems)];
}

function stripJsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const WINDOW_CLAIM = /^(?:midnight in the branch time zone|starts at midnight|from midnight|static 24 hours|static window|not a rolling day|calendar-day window|resets at midnight|calendar day|midnight|12:00 am|each day)$/;

/* Help text, not the marketing list. Comments are dropped. Tags stay,
   so a JSX attribute is still visible. */
export function findSourceClaims(src, rel = "") {
  const stripped = stripJsComments(src);
  const readings = [];
  for (const invisible of ["", " "]) {
    const text = normalize(stripped, invisible, " ", { stripTags: false });
    if (!readings.includes(text)) readings.push(text);
  }
  const problems = [];
  for (const text of readings) claimsIn(text, problems, rel);
  return [...new Set(problems)].filter((problem) => WINDOW_CLAIM.test(problem));
}

export function helpSources() {
  return readdirSync(path.join(root, "os-src"))
    .filter((name) => name.endsWith(".jsx") || name.endsWith(".js"))
    .sort()
    .map((name) => `os-src/${name}`)
    .concat(["web/app/os.js"]);
}

export function checkFiles(rels, read = (rel) => readFileSync(path.join(root, rel), "utf8"), find = findClaims) {
  const problems = [];
  for (const rel of rels) {
    for (const problem of find(read(rel), rel)) problems.push(`${rel}: ${problem}`);
  }
  return problems;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  if (process.argv[2] === "--probe") {
    const problems = findClaims(process.argv[3] ?? "", process.argv[4] ?? "");
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log("ok probe");
    process.exit(0);
  }
  const help = helpSources();
  const problems = [...checkFiles(files), ...checkFiles(help, (rel) => readFileSync(path.join(root, rel), "utf8"), findSourceClaims)];
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ok ${files.length} marketing pages, ${help.length} help sources`);
}
