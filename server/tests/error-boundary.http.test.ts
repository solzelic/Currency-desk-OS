import Fastify from "fastify";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { unexpectedErrorHandler } from "../src/error-boundary.js";

// Framework integration, no app/DB/provider and no listening socket. Kept
// separate from pure callback checks so runtime evidence is reported honestly.
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  let logs = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { stream }, bodyLimit: 64 });
  app.setErrorHandler(unexpectedErrorHandler);
  apps.push(app);
  return { app, logs: () => logs };
}
const secret = "SYNTHETIC-PRIVATE-PAYLOAD";
describe("Fastify error boundary", () => {
  it.each(["throw", "send"])("redacts a database Error via %s", async mode => {
    const { app, logs } = fixture();
    app.get("/failure", async (_req, reply) => {
      const error = Object.assign(new Error(secret), { code: "23505", detail: secret, cause: new Error(secret), stack: secret });
      if (mode === "send") return reply.send(error);
      throw error;
    });
    const res = await app.inject("/failure");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
    expect(logs()).not.toContain(secret);
    expect(logs()).toContain("23505");
  });
  it("does not rewrite an explicit503 response", async () => {
    const { app } = fixture();
    app.get("/unavailable", async (_req, reply) => reply.code(503).send({ error: "not_configured" }));
    const res = await app.inject("/unavailable");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "not_configured" });
  });
  it.each([
    [400, "application/json", "{broken"],
    [413, "application/json", JSON.stringify({ text: "x".repeat(80) })],
    [415, "application/x-unknown", "hello"],
  ] as const)("preserves framework%s refusal", async (status, contentType, payload) => {
    const { app } = fixture();
    app.post("/body", async request => request.body);
    const res = await app.inject({ method: "POST", url: "/body", headers: { "content-type": contentType }, payload });
    expect(res.statusCode).toBe(status);
    expect(res.json().statusCode).toBe(status);
    expect(res.json().code).toMatch(/^FST_/);
  });
  it("preserves schema validation and client error headers", async () => {
    const { app } = fixture();
    app.post("/schema", { schema: { body: { type: "object", required: ["name"] } } }, async () => ({ ok: true }));
    app.get("/limited", async () => { throw Object.assign(new Error("Try later."), { statusCode: 429, headers: { "retry-after": "10" } }); });
    const invalid = await app.inject({ method: "POST", url: "/schema", payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("FST_ERR_VALIDATION");
    const limited = await app.inject("/limited");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("10");
    expect(limited.json().message).toBe("Try later.");
  });
});
