/* Staging "Start on Day 1": POST /api/staging/day-one.

   Registered only inside app.ts's stagingDoorOpen() block (STAGING exactly
   "1"); every request is checked again on its raw Host, before anything
   else. x-forwarded-host and Forwarded are never a host. A live host is 404.

   It is the first unauthenticated staging POST that sets a cookie, so it
   takes only the sign-up page's own same-origin JSON post: a form, a
   text/plain beacon or another site's fetch is 403 before the body is read.

   One press: a new synthetic shop signed up to the point before Open
   (onboarding/staging-day-one.ts), the ordinary enrolment cookie, and the
   owner's generated sign-in once in the body. The page then opens the desk
   through the existing /resume, /staging-open and /open. The body sent is
   ignored. Refusals log a bounded reason only. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientIp } from "../auth/client-ip.js";
import { stagingDoorOpen, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import type { Db } from "../db/index.js";
import { setEnrolmentCookie } from "../onboarding/email-code.js";
import { prepareStagingDayOne, type DayOneResult } from "../onboarding/staging-day-one.js";
import { allowDayOne } from "./staging-fresh-shop.js";

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

/** The sign-up page's own fetch: JSON, from this origin. Sec-Fetch-Site and
    Origin are checked when the browser sends them; https only in production. */
export function sameOriginJson(headers: FastifyRequest["headers"]): boolean {
  const media = first(headers["content-type"]).split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json") return false;
  const site = first(headers["sec-fetch-site"]).trim().toLowerCase();
  if (site && site !== "same-origin") return false;
  const origin = first(headers.origin).trim().toLowerCase();
  if (!origin) return true;
  const host = first(headers.host).trim().toLowerCase();
  if (!host) return false;
  const schemes = process.env.NODE_ENV === "production" ? ["https"] : ["https", "http"];
  return schemes.some((s) => origin === `${s}://${host}`);
}

const UNAVAILABLE = { error: "staging_unavailable", detail: "This staging door can't open a shop just now. No desk was opened." };

export function registerStagingDayOneRoutes(app: FastifyInstance, db: Db): void {
  app.post("/api/staging/day-one", {
    /* Before the body is parsed: the door, then where the post came from. */
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!stagingDoorOpen(req.headers as StagingDoorHeaders)) return reply.code(404).send({ error: "not_found" });
      if (!sameOriginJson(req.headers)) return reply.code(403).send({ error: "cross_site" });
    },
  }, async (req, reply) => {
    if (!allowDayOne(clientIp(req))) return reply.code(429).send({ error: "slow_down" });
    let result: DayOneResult;
    try {
      result = await prepareStagingDayOne(db, req.headers as StagingDoorHeaders);
    } catch {
      result = { ok: false, reason: "step_application" };
    }
    if (!result.ok) {
      req.log.warn({ reason: result.reason }, "staging day one refused");
      return reply.code(503).send(UNAVAILABLE);
    }
    setEnrolmentCookie(reply, result.token);
    reply.header("cache-control", "no-store");
    /* Only these: never the enrolment token, a code or a reference. */
    const { email, password, pin } = result.signIn;
    return reply.code(201).send({ ok: true, cdId: result.cdId, operatingName: result.operatingName, signIn: { email, password, pin } });
  });
}
