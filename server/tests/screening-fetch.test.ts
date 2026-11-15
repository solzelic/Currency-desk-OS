import { describe, expect, it } from "vitest";
import { LIST_BYTE_CAP, fetchOfficial, listShrank, pinnedRedirect } from "../src/screening/fetch.js";

describe("official list fetch", () => {
  it("fails closed when a redirect leaves the official host", async () => {
    const seen: string[] = [];
    await expect(fetchOfficial("https://scsanctions.un.org/resources/xml/en/consolidated.xml", async (input) => {
      seen.push(String(input));
      return new Response("", { status: 302, headers: { location: "https://evil.example/list.xml" } });
    })).rejects.toThrow(/official host/);
    expect(seen).toEqual(["https://scsanctions.un.org/resources/xml/en/consolidated.xml"]);
    expect(() => pinnedRedirect("https://www.international.gc.ca/list.xml", "https://evil.example/list.xml")).toThrow(/official host/);
  });

  it("follows a redirect that stays on an official https host", async () => {
    const seen: string[] = [];
    const result = await fetchOfficial("https://www.international.gc.ca/start.xml", async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/start.xml")) {
        return new Response("", { status: 302, headers: { location: "https://www.international.gc.ca/sema-lmes.xml" } });
      }
      return new Response("<list/>", { status: 200 });
    });
    expect(result).toEqual({ ok: true, status: 200, body: "<list/>" });
    expect(seen).toEqual([
      "https://www.international.gc.ca/start.xml",
      "https://www.international.gc.ca/sema-lmes.xml",
    ]);
  });

  it("refuses a list over the byte cap", async () => {
    await expect(fetchOfficial("https://www.publicsafety.gc.ca/list", async () => {
      return new Response("x".repeat(LIST_BYTE_CAP + 1), { status: 200 });
    })).rejects.toThrow(/byte cap/);
  });

  it("treats a drop of more than 10 percent as a shrink", () => {
    expect(listShrank(10, 9)).toBe(false);
    expect(listShrank(10, 8)).toBe(true);
    expect(listShrank(0, 1)).toBe(false);
  });
});
