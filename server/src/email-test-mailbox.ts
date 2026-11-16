/* A mailbox for the browser suite, and nothing else.

   A sign-up code is never written to the server log, even outside
   production (email.ts: a sensitive message with no provider is refused).
   That is right for every real server, and it means a browser test of the
   visitor's path cannot read the code the way older specs read setup codes.

   So the seam entry (seam-server.ts, which production never imports) may
   open this mailbox. While it is open, a message that would otherwise be
   refused or simulated is kept in memory instead: never sent anywhere,
   never logged, gone when the process ends. The test reads it back through
   a route that only the seam entry registers. No real server opens it. */
import { localTestRequest, localTestRuntime } from "./local-test-runtime.js";
import type { FastifyInstance } from "fastify";

export type TestMail = { to: string; subject: string; text: string; at: number };

let box: TestMail[] | null = null;
let runtime: NodeJS.ProcessEnv | null = null;

/** The open mailbox, or null on every real server. */
export function testMailbox(): TestMail[] | null {
  return runtime && localTestRuntime(runtime) ? box : null;
}

/** Seam entry only: open the mailbox and expose GET /__test/mail?to=. */
export function openTestMailbox(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CD_TEST_MAILBOX !== "1" || !localTestRuntime(env)) return false;
  const mailbox: TestMail[] = [];
  box = mailbox; runtime = env;
  app.addHook("onClose", async () => { if (box === mailbox) { box = null; runtime = null; } });
  app.get<{ Querystring: { to?: string } }>("/__test/mail", async (req, reply) => {
    if (!localTestRuntime(env) || !localTestRequest(req.ip, req.headers.host)) return reply.code(404).send({ error: "not_found" });
    const to = String(req.query.to ?? "").trim().toLowerCase();
    if (!to) return reply.code(400).send({ error: "to_required" });
    return { mail: mailbox.filter((m) => m.to.toLowerCase() === to) };
  });
  return true;
}
