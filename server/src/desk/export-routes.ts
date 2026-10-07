/* Owner download. Anyone else is refused before a query runs.
   The desk is the session's tenant and legal entity. A query string
   cannot point this at another shop. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { tenantPlan } from "../routes/tenant.js";
import { clientsCsv, dealsCsv } from "./export.js";

/* `pool` is the one createDb already opened. Closing the app must not
   end it: the rest of the process is still using it, and handle.close()
   is what ends it. */
export function registerDeskExportRoutes(app: FastifyInstance, db: Db, pool: pg.Pool) {

  const send = async (req: FastifyRequest, reply: FastifyReply, kind: "clients" | "deals") => {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) {
      return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED", message: "Sign in again, then try the download." });
    }
    if ((await tenantPlan(db, user.tenantId)) === "basic") {
      return reply.code(403).send({
        code: "PLAN_NOT_ENTITLED",
        message: "This desk does not keep client and deal records on the server.",
      });
    }
    if (user.role !== "administrator") {
      return reply.code(403).send({
        code: "AUTHORIZATION_DENIED",
        message: "Only the owner of this desk can download clients and deals.",
      });
    }
    if (!user.tenantId || !user.legalEntityId) {
      return reply.code(403).send({
        code: "SCOPE_DENIED",
        message: "This sign-in is not attached to a desk.",
      });
    }
    try {
      const body = kind === "clients"
        ? await clientsCsv(pool, user.tenantId, user.legalEntityId)
        : await dealsCsv(pool, user.tenantId, user.legalEntityId);
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${kind}.csv"`);
      return reply.send(body);
    } catch (error) {
      app.log.error(error, "desk export failed");
      return reply.code(500).send({
        code: "INTERNAL_ERROR",
        message: "The download did not finish. No file was saved.",
      });
    }
  };

  app.get("/api/desk/export/clients.csv", (req, reply) => send(req, reply, "clients"));
  app.get("/api/desk/export/deals.csv", (req, reply) => send(req, reply, "deals"));
}
