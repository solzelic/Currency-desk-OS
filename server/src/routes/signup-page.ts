/* ============================================================
   Which onboarding page a visitor gets (build doc §2, SIGNUP-LOGIC §2.1).

     /onboarding               sign-up v2.1 (web/signup.html): welcome, then
                               the CurrencyDesk ID typed in. The "You're in"
                               email and Early Access link here, no token.
     /onboarding/sso           where Google or Microsoft send the person back
                               (web/signup-sso.html hands code + state to the
                               page that started it). Set SSO_REDIRECT_URI to
                               <origin>/onboarding/sso.
     /onboarding/<reference>   the older setup page, unchanged, for the
                               applications that were invited with a setup
                               reference. A reference that exists always wins
                               (the walkthrough's CD-WALKTHRU has an ID's shape).
     /onboarding/<CD-ID>       v2.1 as well; the page still asks them to type it.

   TEST ONLY: with SIGNUP_TEST_SEED=1, outside production and outside staging,
   /onboarding?step=<state> opens the page on that state with the prototype's
   own review data (reference/tools/capture.cjs, build doc §10). Nothing else
   about the page changes, and a live or staging server never does this.
   ============================================================ */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";

export const SIGNUP_PAGE = "web/signup.html";
export const SIGNUP_SSO_PAGE = "web/signup-sso.html";
export const LEGACY_ONBOARDING_PAGE = "web/onboarding.html";

const SEED_STEP = /^[a-z0-9-]{2,24}$/;

/** True only on a disposable test server. */
export function seedAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNUP_TEST_SEED === "1" && env.NODE_ENV !== "production" && env.STAGING !== "1";
}

export function registerSignupPages(app: FastifyInstance, db: Db, staticDir: string, have: { signup: boolean; legacy: boolean; sso: boolean }): void {
  const seeding = seedAllowed();
  const seeded = (step: string): string => {
    const html = readFileSync(path.join(staticDir, SIGNUP_PAGE), "utf8");
    return html.replace("<head>", `<head><script>window.__cdSeedStep=${JSON.stringify(step)};</script>`);
  };
  async function referenceExists(ref: string): Promise<boolean> {
    const rows = await db.select({ id: schema.enquiries.id }).from(schema.enquiries)
      .where(eq(schema.enquiries.reference, ref.trim().toUpperCase())).limit(1);
    return rows.length > 0;
  }

  if (have.signup) {
    app.get<{ Querystring: { step?: string } }>("/onboarding", (req, reply) => {
      const step = typeof req.query.step === "string" ? req.query.step : "";
      if (seeding && SEED_STEP.test(step)) return reply.type("text/html; charset=utf-8").send(seeded(step));
      return reply.sendFile(SIGNUP_PAGE);
    });
  }
  /* a deploy without the v2.1 page keeps the older one at the bare address */
  else if (have.legacy) app.get("/onboarding", (_req, reply) => reply.sendFile(LEGACY_ONBOARDING_PAGE));
  if (have.sso) app.get("/onboarding/sso", (_req, reply) => reply.sendFile(SIGNUP_SSO_PAGE));
  app.get<{ Params: { code: string } }>("/onboarding/:code", async (req, reply) => {
    const code = req.params.code;
    const v21 = have.signup && !!normalizeCdIdInput(code) && !(await referenceExists(code));
    if (v21) return reply.sendFile(SIGNUP_PAGE);
    if (have.legacy) return reply.sendFile(LEGACY_ONBOARDING_PAGE);
    return reply.code(404).send({ error: "not_found" });
  });
}
