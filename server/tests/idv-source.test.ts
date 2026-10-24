/* Source locks. Persona key names stay in the settings adapter.
   Webhook signature bytes are compared with timingSafeEqual. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("idv source locks", () => {
  it("names PERSONA_API_KEY only in the persona settings adapter", () => {
    const adapter = join(root, "idv/providers/persona.ts");
    const hits = files(root).filter((path) => path !== adapter).filter((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("PERSONA_API_KEY") || text.includes("PERSONA_TEMPLATE_ID");
    });
    expect(readFileSync(adapter, "utf8")).toContain("PERSONA_API_KEY");
    expect(readFileSync(adapter, "utf8")).not.toContain("PERSONA_TEMPLATE_ID");
    expect(hits).toEqual([]);
  });

  it("compares the webhook signature with timingSafeEqual", () => {
    const text = readFileSync(join(root, "idv/providers/persona/index.ts"), "utf8");
    const body = text.slice(text.indexOf("function setOk"), text.indexOf("function verify"));
    const compared = body.split("\n").filter((line) => line.includes("===") && !line.includes(".length ==="));
    expect(body).toContain("timingSafeEqual(");
    expect(compared).toEqual([]);
  });
});
