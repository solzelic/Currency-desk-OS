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

  it("does not say Approved on the identity check", () => {
    const clients = readFileSync(join(import.meta.dirname, "../../os-src/cdos-clients.jsx"), "utf8");
    const delegated = clients.slice(clients.indexOf("function IdentityCheck"), clients.indexOf("function ProcessStanding"));
    expect(delegated).toContain("window.CDOS.IdCheck.Panel");
    expect(delegated).not.toContain("Approved");
    const panelFile = readFileSync(join(import.meta.dirname, "../../os-src/cdos-id-check.jsx"), "utf8");
    const panel = panelFile.slice(panelFile.indexOf("function Panel"), panelFile.indexOf("function DealBar"));
    expect(panel).not.toContain("Approved");
    expect(panel).toContain("Check passed (test)");
    expect(panel).toContain("Check passed");
    expect(panel).toContain("ID details from a finished check are kept on the server. This screen shows the last 4 of the number.");
    expect(panel).not.toContain("ID details from this check are not saved on the desk");
  });

  it("prints a typed ID from one helper on every reader", () => {
    const root = join(import.meta.dirname, "../..");
    const modules = readFileSync(join(root, "os-src/cdos-modules.jsx"), "utf8");
    expect(modules).toContain("function idStandingLabel");
    expect(modules).toContain("idStandingLabel(rec)");
    for (const file of [
      "os-src/cdos-txmodal.jsx",
      "os-src/cdos-reports.jsx",
      "os-src/cdos-transfers.jsx",
      "os-src/cdos-ledger.jsx",
    ]) {
      expect(readFileSync(join(root, file), "utf8"), file).toContain("idStandingLabel");
    }
  });

  it("compares the webhook signature with timingSafeEqual", () => {
    const text = readFileSync(join(root, "idv/providers/persona/index.ts"), "utf8");
    const body = text.slice(text.indexOf("function setOk"), text.indexOf("function verify"));
    const compared = body.split("\n").filter((line) => line.includes("===") && !line.includes(".length ==="));
    expect(body).toContain("timingSafeEqual(");
    expect(compared).toEqual([]);
  });
});
