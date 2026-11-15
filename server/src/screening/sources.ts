import { parseCanadaXml, parsePublicSafetyHtml, parseUnXml } from "./parse.js";
import type { ListEntry } from "./match.js";

export type ListSource = {
  key: string;
  url: string;
  parse: (body: string) => ListEntry[];
};

/* Official addresses checked on 15 Nov 2026. See docs/SANCTIONS_LISTS.md.
   A redirect is followed only when it stays on one of these HTTPS hosts.
   A cross-host redirect fails the fetch. Store this URL, not a redirect. */
export const LIST_SOURCES: readonly ListSource[] = [
  {
    key: "ca-sema",
    url: "https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml",
    parse: parseCanadaXml,
  },
  {
    key: "un-sc",
    url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    parse: parseUnXml,
  },
  {
    key: "ca-cc",
    url: "https://www.publicsafety.gc.ca/cnt/ntnl-scrt/cntr-trrrsm/lstd-ntts/crrnt-lstd-ntts-en.aspx",
    parse: parsePublicSafetyHtml,
  },
];
