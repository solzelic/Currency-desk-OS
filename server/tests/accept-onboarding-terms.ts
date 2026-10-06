/* The invite link does not open setup until the 26 July 2026 terms
   are on the row. Suites that save answers or launch a desk accept
   them first, the way the terms screen does. */
import type { FastifyInstance } from "fastify";
import { ONBOARDING_TERMS_VERSION } from "../src/routes/onboarding-public.js";

export async function acceptOnboardingTerms(app: FastifyInstance, reference: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/onboarding/${reference}/terms`,
    payload: { termsAccepted: true, termsVersion: ONBOARDING_TERMS_VERSION },
  });
  if (res.statusCode !== 200) {
    throw new Error(`accept terms for ${reference} failed: ${res.statusCode} ${res.body}`);
  }
}
