/* Swappable identity check. Sandbox step: interface, signature, inquiry map.
   Shop settings use IdvSettingsProvider. The webhook uses IdvProvider.
   The two stay separate so neither adapter has to implement the other. */

export type IdvOutcome = "pending" | "approved" | "declined" | "review" | "failed" | "expired" | "unknown";

/* Our result. Provider types stay inside the adapter. */
export type IdvResult = {
  eventId: string;
  provider: string;
  providerRef: string;
  referenceId: string;
  outcome: IdvOutcome;
  /* Set by the adapter for created, started, and needs review. */
  inquiryStatus?: "in progress" | "needs review";
  /* A watchlist event is acknowledged and not stored. */
  ignore?: boolean;
};

export type IdvStart = {
  referenceId: string;
  shopId: string;
  branchId: string;
  tellerId: string;
  apiKeyRef?: string | null;
  templateId?: string | null;
  shopCode?: string;
};

/* The ledger connection, when client files live there rather than on the app database. */
export type ClientLookup = {
  query(text: string, values: readonly unknown[]): Promise<{ rowCount?: number | null }>;
};

export type IdvWebhookInput = {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  now?: number;
};

export interface IdvProvider {
  readonly name: string;
  ready?(input: IdvStart): boolean;
  startCheck(input: IdvStart): Promise<{ providerRef: string }>;
  verifyWebhook(input: IdvWebhookInput): boolean;
  parseResult(body: unknown): IdvResult | null;
}

/* Field rules for per-shop settings. */
export type IdvFieldIssue = "template" | "reference";

export interface IdvSettingsProvider {
  id: string;
  fieldIssue(input: { apiKeyRef: string | null; templateId: string | null; shopCode?: string }): IdvFieldIssue | null;
}
