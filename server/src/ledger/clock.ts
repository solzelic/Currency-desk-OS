import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";

/* The product clock is the real one. Tests that have to stand just after
   midnight send `x-cd-now` and set CD_TEST_CLOCK=1 on the test server.
   Importing this module does nothing to the process: the header hook is
   registered only by bindTestClock, and only when the flag is allowed.
   Production with the flag set never reaches a request. */
const clock = new AsyncLocalStorage<Date>();

export const TEST_CLOCK_PRODUCTION_ERROR = "CD_TEST_CLOCK must never be set in production";

/** Production must not be able to honour a client-supplied clock. */
export function assertTestClockAllowed(): void {
  if (process.env.NODE_ENV === "production" && process.env.CD_TEST_CLOCK === "1") {
    throw new Error(TEST_CLOCK_PRODUCTION_ERROR);
  }
}

export function now(): Date {
  return clock.getStore() ?? new Date();
}

/** Run `fn` as if `at` were the current instant. Tests use this to stand
    on a calendar date. Production does not. */
export function withNow<T>(at: Date, fn: () => T): T {
  if (Number.isNaN(at.getTime())) throw new Error("withNow needs a real instant");
  return clock.run(at, fn);
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
  assertTestClockAllowed();
  /* No hook at all unless a test server asked for one. A production
     process never reaches this with the flag set — it has already
     refused to boot — and a production process without the flag does
     not grow a request hook that knows the header exists. */
  if (process.env.CD_TEST_CLOCK !== "1") return;
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
