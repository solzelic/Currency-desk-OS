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

const kept = (value: unknown, max = 4000): string | null => {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : null;
};

const websiteHost = (value: unknown): string | null => {
  const raw = kept(value, 300);
  if (!raw || raw === "none yet") return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname || null;
  } catch {
    return null;
  }
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
        safe_search: true,
        include_domains: includeDomains,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Tavily search failed (${response.status}).`);
    return await response.json() as TavilyResponse;
  };

  const extract = async (urls: string[], query: string): Promise<TavilyExtractResponse> => {
    const response = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ urls, query, chunks_per_source: 3, extract_depth: "basic", include_usage: true }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Tavily extract failed (${response.status}).`);
    return await response.json() as TavilyExtractResponse;
  };

  return {
    name: "tavily",
    model: "tavily-search-basic",
    async research(lead) {
      const business = kept(lead.details.shopName, 180) ?? kept(lead.name, 180) ?? lead.email;
      const jurisdiction = kept(lead.details.jurisdiction, 80) ?? "Canada";
      const host = websiteHost(lead.details.website);
      const tasks: { label: string; method: ResearchFactInput["method"]; promise: Promise<TavilyResponse> }[] = [];
      if (host) {
        tasks.push({
          label: "website_profile",
          method: "website_read",
          promise: search(`site:${host} ${business} currency exchange services locations compliance`),
        });
      }
      tasks.push({
        label: "business_search",
        method: "web_search",
        promise: search(`\"${business}\" currency exchange ${jurisdiction} locations owners services`),
      });
      tasks.push({
        label: "fintrac_registry",
        method: "registry",
        promise: search(`\"${business}\" FINTRAC MSB registration`, ["fintrac-canafe.canada.ca"]),
      });

      const responses = await Promise.all(tasks.map((task) => task.promise));
      const facts: ResearchFactInput[] = [];
      const sections: string[] = [];
      let credits = 0;
      for (let taskIndex = 0; taskIndex < responses.length; taskIndex += 1) {
        const response = responses[taskIndex]!;
        const task = tasks[taskIndex]!;
        const results = Array.isArray(response.results) ? response.results as TavilyResult[] : [];
        const candidates = results.flatMap((result) => {
          const url = kept(result.url, 1000);
          return url ? [url] : [];
        }).slice(0, 4);
        if (!candidates.length) continue;
        const extracted = await extract(candidates, `${business} business identity services ownership locations and regulatory registration evidence`);
        const extractedByUrl = new Map((extracted.results ?? []).flatMap((result) => {
          const url = kept(result.url, 1000);
          const content = kept(result.raw_content, 10_000);
          return url && content ? [[sourceKey(url), content] as const] : [];
        }));
        const sourced = results.flatMap((result, index) => {
          const sourceUrl = kept(result.url, 1000);
          const value = sourceUrl ? extractedByUrl.get(sourceKey(sourceUrl)) ?? null : null;
          if (!sourceUrl || !value) return [];
          const normalizedBusiness = business.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const matchesBusiness = normalizedBusiness.length > 3 && value.toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(normalizedBusiness);
          // This is source-match strength, not a claim that the content is
          // true. The UI names it that way; an operator still opens sources.
          const score = task.method === "website_read" ? 0.85 : task.method === "registry" ? (matchesBusiness ? 0.8 : 0.45) : (matchesBusiness ? 0.72 : 0.55);
          return [{
            key: factKey(task.label, index),
            value,
            sourceUrl,
            confidence: score,
            method: task.method,
          } satisfies ResearchFactInput];
        });
        facts.push(...sourced);
        if (sourced.length) sections.push(`${task.label.replaceAll("_", " ")}: ${sourced.length} extracted source${sourced.length === 1 ? "" : "s"}. ${sourced.map((fact) => fact.sourceUrl).join(", ")}`);
        const used = Number(response.usage?.credits);
        if (Number.isFinite(used) && used > 0) credits += used;
        const extractUsed = Number(extracted.usage?.credits);
        if (Number.isFinite(extractUsed) && extractUsed > 0) credits += extractUsed;
      }

      if (!facts.length) {
        throw new Error("Research returned no sourced findings.");
      }
      const registryMatch = facts.some((fact) => fact.method === "registry" && fact.confidence >= 0.8);
      const summary = `${business}: ${facts.length} sourced finding${facts.length === 1 ? "" : "s"} extracted for staff review. FINTRAC registration ${registryMatch ? "has a possible name match that requires human confirmation" : "was not confirmed by this run"}.`;
      return {
        summary: `${summary}\n\n${sections.join("\n\n")}`,
        brief: {
          executiveSummary: summary,
          sourceCount: new Set(facts.map((fact) => fact.sourceUrl)).size,
          registryStatus: registryMatch ? "possible_match" : "not_confirmed",
          talkingPoints: ["Confirm the business model and locations.", "Ask how the team currently handles rates, cash ownership and compliance work."],
          openQuestions: registryMatch ? ["Confirm the FINTRAC record belongs to this applicant."] : ["Ask for the legal business name and MSB registration number.", "Confirm whether registration is pending or held under another legal name."],
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
    await input.db.insert(schema.enquiryResearchRuns).values({
      id: runId,
      enquiryId: input.enquiry.id,
      runAt,
      provider: input.provider.name,
      model: input.provider.model,
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 2000) : "Research failed.",
      createdBy: input.createdBy,
    });
    throw new ResearchUnavailable("research_failed", "Lead research failed. The attempt is recorded; no applicant data was changed.", 502);
  }
  return runId;
}
