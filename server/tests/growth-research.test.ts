import { afterEach, describe, expect, it, vi } from "vitest";
import { tavilyResearchProvider } from "../src/growth/research.js";

afterEach(() => vi.unstubAllGlobals());

describe("Tavily lead research", () => {
  it("uses search for discovery and extract for the cited brief", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; urls?: string[] };
      if (url.endsWith("/search")) {
        const fintrac = body.query?.includes("FINTRAC");
        const website = body.query?.startsWith("site:");
        const source = fintrac
          ? "https://fintrac-canafe.canada.ca/msb-esm/registry-registre/42"
          : website ? "https://northstar.example/about" : "https://directory.example/north-star";
        return new Response(JSON.stringify({ results: [{ url: source, title: "North Star FX", content: "search snippet", score: 0.91 }], usage: { credits: 1 } }), { status: 200 });
      }
      const source = body.urls?.[0] ?? "";
      const content = source.includes("fintrac")
        ? "North Star FX appears in this registry search result. Verify the legal entity and registration status."
        : "North Star FX provides currency exchange services from Toronto.";
      return new Response(JSON.stringify({ results: [{ url: source, raw_content: content }], usage: { credits: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = tavilyResearchProvider({ TAVILY_API_KEY: "test-key", TAVILY_CREDIT_COST_CENTS: "2" });
    expect(provider).not.toBeNull();

    const output = await provider!.research({
      enquiryId: "lead-1", reference: "CD-LEAD01", name: "Mira Chen", email: "mira@northstar.example",
      details: { shopName: "North Star FX", website: "northstar.example", jurisdiction: "Canada" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/search"));
    expect(searchCalls).toHaveLength(3);
    expect(JSON.parse(String(searchCalls[0]?.[1]?.body))).toMatchObject({
      search_depth: "basic", max_results: 4, include_usage: true,
    });
    expect(JSON.parse(String(searchCalls[0]?.[1]?.body))).not.toHaveProperty("safe_search");
    const extractCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/extract"));
    expect(extractCalls).toHaveLength(3);
    expect(JSON.parse(String(extractCalls[0]?.[1]?.body))).toMatchObject({ chunks_per_source: 3, extract_depth: "basic" });
    expect(output.facts).toHaveLength(3);
    expect(output.facts.every((fact) => fact.sourceUrl && !fact.value.includes("search snippet"))).toBe(true);
    expect(output.brief).toMatchObject({ sourceCount: 3, registryStatus: "possible_match" });
    expect(output.creditsUsed).toBe(6);
    expect(output.costCents).toBe(12);
  });

  it("keeps a provider rejection useful without exposing a Tavily key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Project is not allowed for this request: tvly-secret-key" }), { status: 403 })));
    const provider = tavilyResearchProvider({ TAVILY_API_KEY: "test-key" });

    await expect(provider!.research({
      enquiryId: "lead-1", reference: "CD-LEAD01", name: "Mira Chen", email: "mira@northstar.example",
      details: { shopName: "North Star FX", jurisdiction: "Canada" },
    })).rejects.toThrow("Tavily search failed (403): Project is not allowed for this request: [redacted].");
  });
});
