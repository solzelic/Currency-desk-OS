/* ============================================================
   Lead research.

   Results are immutable snapshots and every fact is sourced. The applicant's
   `enquiries.details` row is input only; nothing here writes to it.
   ============================================================ */
import { randomUUID } from "node:crypto";
import { schema, type Db } from "../db/index.js";
import type { ResearchBrief } from "../db/schema.js";

export type ResearchFactInput = {
  key: string;
  value: string;
  sourceUrl: string;
  confidence: number;
  method: typeof schema.enquiryResearchFacts.$inferInsert.method;
};

export type ResearchLead = {
  enquiryId: string;
  reference: string;
  name: string | null;
  email: string;
  details: Record<string, unknown>;
};

export type ResearchOutput = {
  summary: string;
  brief?: ResearchBrief;
  facts: ResearchFactInput[];
  creditsUsed: number | null;
  costCents: number | null;
};

export interface LeadResearchProvider {
  name: string;
  model: string;
  research(lead: ResearchLead): Promise<ResearchOutput>;
}

export class ResearchUnavailable extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 503) {
    super(message);
  }
}

type TavilyResult = { title?: unknown; url?: unknown; content?: unknown; score?: unknown };
type TavilyResponse = {
  answer?: unknown;
  results?: unknown;
  usage?: { credits?: unknown };
};
type TavilyExtractResponse = {
  results?: { url?: unknown; raw_content?: unknown }[];
  usage?: { credits?: unknown };
};

const safeTavilyError = async (response: Response, operation: "search" | "extract"): Promise<Error> => {
  // Provider error bodies often explain a rejected request, but they must never
  // become a route for reflecting credentials into the applicant timeline.
  // Keep only a short, printable message and redact key-shaped strings.
  const raw = await response.text().catch(() => "");
  let message = "";
  try {
    const body = JSON.parse(raw) as { detail?: unknown; error?: unknown; message?: unknown };
    const candidate = body.detail ?? body.error ?? body.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    // Non-JSON failures (for example a proxy page) are deliberately not shown
    // to staff. The status still gives support a useful, safe diagnostic.
  }
  message = message
    .replace(/tvly-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .trim()
    .slice(0, 240);
  return new Error(`Tavily ${operation} failed (${response.status})${message ? `: ${message}` : ""}.`);
};

const kept = (value: unknown, max = 4000): string | null => {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : null;
};

const websiteUrl = (value: unknown): string | null => {
  const raw = kept(value, 300);
  if (!raw || raw === "none yet") return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ["http:", "https:"].includes(url.protocol) && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
};

const websiteHost = (value: string | null): string | null => {
  if (!value) return null;
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
};

const normal = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const businessName = (details: Record<string, unknown>): string | null =>
  kept(details.shopName, 180) ?? kept(details.businessName, 180) ?? kept(details.legalName, 180) ?? kept(details.companyName, 180);
const namesBusiness = (value: string, business: string): boolean => normal(business).length >= 3 && normal(value).includes(normal(business));
const sameDomain = (url: string, host: string): boolean => {
  try {
    const actual = new URL(url).hostname.toLowerCase();
    return actual === host || actual.endsWith(`.${host}`);
  } catch { return false; }
};
const canada = (value: string | null): boolean => /(^|\b)(ca|canada|canadian)(\b|$)/i.test(value ?? "");
const cleanEvidence = (value: string, business: string): string | null => {
  const compact = value.replace(/\s+/g, " ").replace(/\[(?:\.{3}|…)?\]/g, " ").trim();
  const index = compact.toLowerCase().indexOf(business.toLowerCase());
  if (index < 0) return namesBusiness(compact, business) ? compact.slice(0, 720) : null;
  const start = Math.max(0, index - 180);
  const end = Math.min(compact.length, index + business.length + 540);
  return `${start ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
};

const factKey = (prefix: string, index: number): string => `${prefix}_${index + 1}`;
const sourceKey = (value: string): string => value.replace(/\/$/, "");

export function tavilyResearchProvider(env: NodeJS.ProcessEnv = process.env): LeadResearchProvider | null {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) return null;
  const centValue = env.TAVILY_CREDIT_COST_CENTS == null ? null : Number(env.TAVILY_CREDIT_COST_CENTS);
  const centsPerCredit = centValue != null && Number.isFinite(centValue) && centValue >= 0 ? centValue : null;

  const search = async (query: string, includeDomains: string[] = []): Promise<TavilyResponse> => {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 4,
        include_answer: false,
        include_usage: true,
        include_domains: includeDomains,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw await safeTavilyError(response, "search");
    return await response.json() as TavilyResponse;
  };

  const extract = async (urls: string[], query: string): Promise<TavilyExtractResponse> => {
    const response = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ urls, query, chunks_per_source: 3, extract_depth: "basic", include_usage: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await safeTavilyError(response, "extract");
    return await response.json() as TavilyExtractResponse;
  };

  return {
    name: "tavily",
    model: "tavily-search-basic",
    async research(lead) {
      /* A person’s name or email is not a business identity. Falling back to
         either caused generic “currency exchange” pages to be filed against
         an applicant. We now do no public lookup until the applicant has
         named the business we are trying to verify. */
      const business = businessName(lead.details);
      if (!business) {
        throw new ResearchUnavailable(
          "business_identity_required",
          "Research needs the applicant's business or legal name. We will not search a person's name or email as a substitute.",
          422,
        );
      }
      const jurisdiction = kept(lead.details.jurisdiction, 80);
      const city = kept(lead.details.city, 100);
      const site = websiteUrl(lead.details.website);
      const host = websiteHost(site);
      const tasks: { label: string; method: ResearchFactInput["method"]; direct?: boolean; promise: Promise<TavilyResponse> | Promise<TavilyExtractResponse> }[] = [];
      if (site) tasks.push({ label: "applicant_website", method: "website_read", direct: true,
        // Read the address the applicant gave us directly. A search engine is
        // useful for discovery, but it is not proof that a result is theirs.
        promise: extract([site], `${business} business identity services locations`),
      });
      tasks.push({ label: "public_business_source", method: "web_search",
        promise: search(`\"${business}\"${city ? ` ${city}` : ""}${jurisdiction ? ` ${jurisdiction}` : ""}`),
      });
      if (canada(jurisdiction)) tasks.push({ label: "fintrac_registry", method: "registry",
        promise: search(`\"${business}\" FINTRAC MSB registration`, ["fintrac-canafe.canada.ca"]),
      });

      const responses = await Promise.all(tasks.map((task) => task.promise));
      const facts: ResearchFactInput[] = [];
      let credits = 0;
      for (let taskIndex = 0; taskIndex < responses.length; taskIndex += 1) {
        const response = responses[taskIndex]!;
        const task = tasks[taskIndex]!;
        const discovery = task.direct ? null : response as TavilyResponse;
        const directExtract = task.direct ? response as TavilyExtractResponse : null;
        const results = Array.isArray(discovery?.results) ? discovery.results as TavilyResult[] : [];
        /* Search snippets are only candidates. We extract no result unless
           its own title or snippet names the stated business exactly. */
        const candidates = results.flatMap((result) => {
          const url = kept(result.url, 1000);
          const identityText = [kept(result.title, 500), kept(result.content, 2_000)].filter(Boolean).join(" ");
          return url && namesBusiness(identityText, business) ? [url] : [];
        }).slice(0, 2);
        const extracted = directExtract ?? (candidates.length
          ? await extract(candidates, `${business} business identity services locations regulatory registration`)
          : null);
        if (!extracted) continue;
        const extractedByUrl = new Map((extracted.results ?? []).flatMap((result) => {
          const url = kept(result.url, 1000);
          const content = kept(result.raw_content, 8_000);
          return url && content ? [[sourceKey(url), content] as const] : [];
        }));
        const sourced = [...extractedByUrl.entries()].flatMap(([url, raw], index) => {
          if (task.direct && (!host || !sameDomain(url, host))) return [];
          const value = cleanEvidence(raw, business);
          // Even the supplied website must name the business in the extracted
          // page. A domain alone is not evidence of the applicant’s company.
          if (!value) return [];
          return [{
            key: factKey(task.label, index), value, sourceUrl: url,
            confidence: task.method === "website_read" ? 0.95 : task.method === "registry" ? 0.9 : 0.85,
            method: task.method,
          } satisfies ResearchFactInput];
        });
        facts.push(...sourced);
        const used = Number((response as TavilyResponse | TavilyExtractResponse).usage?.credits);
        if (Number.isFinite(used) && used > 0) credits += used;
        if (!directExtract) {
          const extractUsed = Number(extracted.usage?.credits);
          if (Number.isFinite(extractUsed) && extractUsed > 0) credits += extractUsed;
        }
      }

      if (!facts.length) {
        throw new ResearchUnavailable(
          "business_identity_not_confirmed",
          `No public source named \"${business}\" exactly. Nothing was saved as a finding; check the business name and website before re-running research.`,
          422,
        );
      }
      const registryMatch = facts.some((fact) => fact.method === "registry" && fact.confidence >= 0.8);
      const summary = `${business}: ${facts.length} public source${facts.length === 1 ? "" : "s"} named the stated business exactly and passed the identity check. FINTRAC registration ${registryMatch ? "has a possible name match that requires human confirmation" : "was not confirmed by this run"}.`;
      return {
        summary,
        brief: {
          executiveSummary: summary,
          sourceCount: new Set(facts.map((fact) => fact.sourceUrl)).size,
          registryStatus: registryMatch ? "possible_match" : "not_confirmed",
          talkingPoints: [`Confirm that ${business} is the legal or trading name.`, "Ask how the team currently handles rates, cash ownership and compliance work."],
          openQuestions: registryMatch ? ["Confirm the FINTRAC record belongs to this applicant."] : ["Ask for the legal business name and MSB registration number.", "Confirm whether registration is pending or held under another legal name."],
          identity: { businessName: business, websiteHost: host, verification: "exact_business_name" },
        },
        facts,
        creditsUsed: credits || null,
        costCents: centsPerCredit == null || !credits ? null : Math.round(credits * centsPerCredit),
      };
    },
  };
}

export async function researchEnquiry(input: {
  db: Db;
  enquiry: typeof schema.enquiries.$inferSelect;
  createdBy: string;
  provider: LeadResearchProvider;
  now?: () => Date;
}) {
  const runId = randomUUID();
  const runAt = input.now?.() ?? new Date();
  const details = (input.enquiry.details ?? {}) as Record<string, unknown>;
  try {
    const output = await input.provider.research({
      enquiryId: input.enquiry.id,
      reference: input.enquiry.reference,
      name: input.enquiry.name,
      email: input.enquiry.email,
      details,
    });
    /* Defence in depth: the database has the same constraints, but rejecting
       before insertion gives an integration a useful error. */
    const facts = output.facts.filter((fact) =>
      kept(fact.key, 120) && kept(fact.value) && kept(fact.sourceUrl, 1000) &&
      Number.isFinite(fact.confidence) && fact.confidence >= 0 && fact.confidence <= 1,
    );
    if (!facts.length) throw new Error("Research returned no sourced findings.");
    const brief: ResearchBrief = output.brief ?? {
      executiveSummary: output.summary.slice(0, 3000),
      sourceCount: new Set(facts.map((fact) => fact.sourceUrl)).size,
      registryStatus: facts.some((fact) => fact.method === "registry" && fact.confidence >= 0.8) ? "possible_match" : "not_confirmed",
      talkingPoints: ["Confirm the applicant's current workflow and goals."],
      openQuestions: ["Verify any material finding before relying on it in the call."],
    };

    await input.db.transaction(async (tx) => {
      await tx.insert(schema.enquiryResearchRuns).values({
        id: runId,
        enquiryId: input.enquiry.id,
        runAt,
        provider: input.provider.name,
        model: input.provider.model,
        status: "complete",
        summary: output.summary.slice(0, 20_000),
        brief,
        creditsUsed: output.creditsUsed,
        costCents: output.costCents,
        createdBy: input.createdBy,
      });
      await tx.insert(schema.enquiryResearchFacts).values(facts.map((fact) => ({
        id: randomUUID(),
        researchId: runId,
        key: fact.key.slice(0, 120),
        value: fact.value.slice(0, 10_000),
        sourceUrl: fact.sourceUrl.slice(0, 1000),
        confidence: fact.confidence,
        method: fact.method,
      })));
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 2000) : "Research failed.";
    await input.db.insert(schema.enquiryResearchRuns).values({
      id: runId,
      enquiryId: input.enquiry.id,
      runAt,
      provider: input.provider.name,
      model: input.provider.model,
      status: "failed",
      error: detail,
      createdBy: input.createdBy,
    });
    if (error instanceof ResearchUnavailable) throw error;
    throw new ResearchUnavailable("research_failed", "Lead research failed. The attempt is recorded; no applicant data was changed.", 502);
  }
  return runId;
}
