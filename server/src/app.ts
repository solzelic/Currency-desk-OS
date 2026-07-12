/* ============================================================
   App assembly — split from index.ts so tests can build the
   full HTTP app against an embedded database with app.inject().

   When STATIC_DIR is set (production), the server also serves the
   built frontend from that directory — one origin for app + API,
   so session cookies work with no CORS configuration.
   ============================================================ */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db/index.js";
import { registerAuthRoutes } from "./routes/auth.js";

export async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  await app.register(cookie);

  app.get("/api/health", async () => ({ ok: true, service: "currencydesk-server" }));
  registerAuthRoutes(app, db);

  // serve the built frontend (vite build → dist) when configured
  const staticDir = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, index: false });
    // the vite build's entry is frontend.html (see vite.config.ts);
    // SPA fallback for every non-API GET
    app.get("/", (_req, reply) => reply.sendFile("frontend.html"));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("frontend.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
