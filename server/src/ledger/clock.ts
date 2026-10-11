import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

/* The product clock is the real one. Tests that have to stand just after
   midnight send `x-cd-now` and set CD_TEST_CLOCK=1 on the test server.
   Production does not set that variable, so the header is ignored there
   even if a client sends it. */
const clock = new AsyncLocalStorage<Date>();

export function now(): Date {
  return clock.getStore() ?? new Date();
}

function testInstant(header: string | string[] | undefined): Date | null {
  if (process.env.CD_TEST_CLOCK !== "1") return null;
  if (header == null || header === "") return null;
  if (Array.isArray(header)) throw new Error("x-cd-now was sent more than once");
  const at = new Date(header);
  if (Number.isNaN(at.getTime())) throw new Error("x-cd-now is not a time");
  return at;
}

export function bindTestClock(app: FastifyInstance): void {
  app.addHook("onRequest", (req, reply, done) => {
    let at: Date | null;
    try {
      at = testInstant(req.headers["x-cd-now"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "x-cd-now is not a time";
      reply.code(400).send({ code: "INVALID_REQUEST", message });
      return;
    }
    if (!at) {
      done();
      return;
    }
    clock.run(at, () => done());
  });
}
