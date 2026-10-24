/* Field rules for the persona provider. */
import type { IdvSettingsProvider } from "../provider.js";

const TEMPLATE = /^(itmpl|itmplv|tmpl)_[A-Za-z0-9_-]{1,80}$/;

export const personaProvider: IdvSettingsProvider = {
  id: "persona",
  fieldIssue(input) {
    const ref = input.apiKeyRef?.toLowerCase() ?? "";
    if (ref.startsWith("persona_") || ref.includes("wbhsec")) return "reference";
    if (input.templateId && !TEMPLATE.test(input.templateId)) return "template";
    return null;
  },
};
