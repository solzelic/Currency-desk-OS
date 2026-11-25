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
    expect(panelFile).toContain("function retentionSentence");
    expect(panel).toContain("retentionSentence(latest, typedOnly)");
    expect(panel).not.toContain("ID details from a finished check are kept on the server. This screen shows the last 4 of the number.");
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

  it("names the Didit secrets only in the Didit adapter", () => {
    const adapter = join(root, "idv/providers/didit.ts");
    const names = ["DIDIT_API_KEY", "DIDIT_WEBHOOK_SECRET", "DIDIT_WORKFLOW_ID", "DIDIT_AML_WORKFLOW_ID", "DIDIT_LIVE_ALLOWED"];
    const hits = files(root).filter((path) => path !== adapter).filter((path) => {
      const text = readFileSync(path, "utf8");
      return names.some((name) => text.includes(name));
    });
    const text = readFileSync(adapter, "utf8");
    for (const name of names) expect(text).toContain(name);
    expect(hits).toEqual([]);
  });

  it("paints a disabled ID check button with the muted surface", () => {
    const source = readFileSync(join(import.meta.dirname, "../../os-src/cdos-id-check.jsx"), "utf8");
    const style = source.slice(source.indexOf("const btnStyle"), source.indexOf("const ghost"));
    expect(style).toContain('disabled ? "var(--cd-disabled)"');
    expect(style).toContain('disabled ? "var(--cd-mute)"');
    expect(style).not.toContain("#E4E1D8");
    expect(style).not.toContain("#3F3C36");
  });

  it("compares the webhook signature with timingSafeEqual", () => {
    const text = readFileSync(join(root, "idv/providers/persona/index.ts"), "utf8");
    const body = text.slice(text.indexOf("function setOk"), text.indexOf("function verify"));
    const compared = body.split("\n").filter((line) => line.includes("===") && !line.includes(".length ==="));
    expect(body).toContain("timingSafeEqual(");
    expect(compared).toEqual([]);
  });
});
