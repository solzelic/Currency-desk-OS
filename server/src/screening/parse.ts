import { parseDobField, type DobConstraint } from "./names.js";
import type { ListEntry } from "./match.js";

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return found ? decode(found[1] ?? "") : "";
}

function splitAliases(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
}

function unique(entries: ListEntry[]): ListEntry[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const n = seen.get(entry.key) ?? 0;
    seen.set(entry.key, n + 1);
    if (n === 0) return entry;
    return { ...entry, key: `${entry.key}#${n}` };
  });
}

function requireEntries(entries: ListEntry[], label: string): ListEntry[] {
  if (!entries.length) throw new Error(`${label} parsed to an empty list`);
  return unique(entries);
}

/** Global Affairs Canada consolidated autonomous sanctions XML (SEMA and JVCFOA). */
export function parseCanadaXml(xml: string): ListEntry[] {
  if (!xml.includes("<data-set") || !xml.includes("<record>")) {
    throw new Error("Canada sanctions XML is not a data-set of records. The file structure changed.");
  }
  const records = xml.split("<record>").slice(1);
  const entries: ListEntry[] = [];
  for (const raw of records) {
    const block = raw.split("</record>")[0] ?? "";
    const last = tag(block, "LastName-NomDeFamille");
    const given = tag(block, "GivenName-Prenom");
    const entity = tag(block, "EntityOrShip-EntiteOuNavire");
    const primary = entity || [given, last].filter(Boolean).join(" ");
    if (!primary) throw new Error("Canada sanctions record has no name. The file structure changed.");
    const schedule = tag(block, "Schedule-Annexe");
    const item = tag(block, "Item-NumeroDarticle");
    const country = tag(block, "Country-Pays");
    const names = [primary, ...splitAliases(tag(block, "Aliases-Alias"))];
    const dobs: DobConstraint[] = entity
      ? []
      : parseDobField(tag(block, "DateOfBirthOrShipBuildDate-DateDeNaissanceOuDateDeConstructionDuNavire"));
    entries.push({
      key: ["ca", schedule, item, country, primary].join("|"),
      names,
      dobs,
    });
  }
  return requireEntries(entries, "Canada sanctions XML");
}

function personName(block: string): string {
  return ["FIRST_NAME", "SECOND_NAME", "THIRD_NAME", "FOURTH_NAME"]
    .map((name) => tag(block, name))
    .filter(Boolean)
    .join(" ");
}

function aliasNames(block: string, wrapper: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${wrapper}>([\\s\\S]*?)</${wrapper}>`, "gi");
  for (const found of block.matchAll(re)) {
    const name = tag(found[1] ?? "", "ALIAS_NAME");
    if (name) out.push(name);
  }
  return out;
}

function dobBlocks(block: string): DobConstraint[] {
  const out: DobConstraint[] = [];
  const re = /<INDIVIDUAL_DATE_OF_BIRTH>([\s\S]*?)<\/INDIVIDUAL_DATE_OF_BIRTH>/gi;
  for (const found of block.matchAll(re)) {
    const inner = found[1] ?? "";
    const date = tag(inner, "DATE");
    const year = tag(inner, "YEAR");
    out.push(...parseDobField(date || year));
  }
  return out;
}

/** UN Security Council consolidated list XML. */
export function parseUnXml(xml: string): ListEntry[] {
  if (!xml.includes("<CONSOLIDATED_LIST") || (!xml.includes("<INDIVIDUAL>") && !xml.includes("<ENTITY>"))) {
    throw new Error("Security Council XML is not a consolidated list. The file structure changed.");
  }
  const entries: ListEntry[] = [];
  const take = (source: string, open: string, close: string, aliasTag: string) => {
    for (const raw of source.split(`<${open}>`).slice(1)) {
      const block = raw.split(`</${close}>`)[0] ?? "";
      const primary = personName(block);
      if (!primary) throw new Error(`Security Council ${open} has no name. The file structure changed.`);
      const dataId = tag(block, "DATAID");
      if (!dataId) throw new Error(`Security Council ${open} has no DATAID. The file structure changed.`);
      entries.push({
        key: `un|${dataId}`,
        names: [primary, ...aliasNames(block, aliasTag)],
        dobs: open === "INDIVIDUAL" ? dobBlocks(block) : [],
      });
    }
  };
  take(xml, "INDIVIDUAL", "INDIVIDUAL", "INDIVIDUAL_ALIAS");
  take(xml, "ENTITY", "ENTITY", "ENTITY_ALIAS");
  return requireEntries(entries, "Security Council XML");
}

/** Public Safety Canada, currently listed terrorist entities page. */
export function parsePublicSafetyHtml(html: string): ListEntry[] {
  const re = /<h2 id="(\d+)">([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2 id="\d+">|$)/gi;
  const entries: ListEntry[] = [];
  for (const found of html.matchAll(re)) {
    const id = found[1] ?? "";
    const title = decode(found[2] ?? "");
    const body = found[3] ?? "";
    if (!title) throw new Error("Public Safety listed entity heading is empty. The page structure changed.");
    if (!body.includes("<strong>Also known as</strong>")) {
      throw new Error(`Public Safety entity ${id} has no Also known as label. The page structure changed.`);
    }
    if (!body.includes("<strong>Date listed</strong>")) {
      throw new Error(`Public Safety entity ${id} has no Date listed label. The page structure changed.`);
    }
    const aka = /<strong>Also known as<\/strong>(?:<br\s*\/?>)?([\s\S]*?)<\/p>/i.exec(body);
    const aliasText = decode(aka?.[1] ?? "").replace(/\.$/, "");
    const aliases = aliasText
      .split(/\s*;\s*|\s+and\s+/i)
      .map((part) => part.trim())
      .filter((part) => part && part.toLowerCase() !== "none");
    entries.push({ key: `cc|${id}`, names: [title, ...aliases], dobs: [] });
  }
  if (!entries.length) {
    throw new Error("Public Safety listed entities page has no numbered headings. The page structure changed.");
  }
  return requireEntries(entries, "Public Safety listed entities page");
}
