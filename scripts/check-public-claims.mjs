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
   phrases are not listed. "static 24 hours" and "within 3 business
   days" are not a banned pattern. */
import { readFileSync } from "node:fs";
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

function normalize(html, invisible, tags = " ") {
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
  text = text.replace(/<meta\b[^>]*>/gi, readMeta);
  text = text.replace(/<[^>]*>/g, tags);
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
  let scanned = text.replace(/\blive rate board\b/g, " ");
  for (const name of HOUR_RULES) scanned = scanned.replaceAll(name, " ");
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

export function checkFiles(rels, read = (rel) => readFileSync(path.join(root, rel), "utf8")) {
  const problems = [];
  for (const rel of rels) {
    for (const problem of findClaims(read(rel), rel)) problems.push(`${rel}: ${problem}`);
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
  const problems = checkFiles(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ok ${files.length} marketing pages`);
}
