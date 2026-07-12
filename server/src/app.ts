/* ============================================================
   App assembly — split from index.ts so tests can build the
   full HTTP app against an embedded database with app.inject().
   ============================================================ */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Db } from "./db/index.js";
import { registerAuthRoutes } from "./routes/auth.js";

export async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  await app.register(cookie);

  app.get("/api/health", async () => ({ ok: true, service: "currencydesk-server" }));
  registerAuthRoutes(app, db);

  return app;
}
