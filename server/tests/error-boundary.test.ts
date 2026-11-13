import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeError, unexpectedErrorHandler } from "../src/error-boundary.js";

const secret = "SYNTHETIC-PRIVATE-PAYLOAD";
describe("safeError allowlist", () => {
  it.each([null, undefined, secret, 42, { message: secret, detail: secret }, Object.assign(new Error(secret), { cause: secret, stack: secret })])("does not serialize arbitrary payloads (%#)", value => {
    expect(JSON.stringify(safeError(value))).not.toContain(secret);
    expect(Object.keys(safeError(value)).sort()).toEqual(["message", "name"]);
  });
  it("retains only known diagnostic identifiers", () => {
    expect(safeError({ name: "DatabaseError", code: "23505", message: secret, detail: secret })).toEqual({ name: "DatabaseError", code: "23505", message: "Unexpected error details redacted." });
    expect(safeError({ name: secret, code: secret }).name).toBe("Error");
    expect(safeError({ code: secret })).not.toHaveProperty("code");
  });
  it("does not call accessors or toJSON", () => {
    let called = 0;
    const value = { get name() { called++; throw new Error(secret); }, get code() { called++; return secret; }, toJSON() { called++; return secret; } };
    expect(JSON.stringify(safeError(value))).not.toContain(secret);
    expect(called).toBe(0);
  });
  it("contains proxy failures without exposing the thrown payload", () => {
    expect(JSON.stringify(safeError(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } })))).not.toContain(secret);
  });
});

function invoke(error: unknown, initialStatus = 200) {
  const logs: unknown[] = [];
  const request = { log: { error: (...args: unknown[]) => logs.push(args) } };
  const reply = { statusCode: initialStatus, body: undefined as unknown, code(n: number) { this.statusCode = n; return this; }, send(body: unknown) { this.body = body; return this; } };
  unexpectedErrorHandler.call({} as never, error, request as never, reply as never);
  return { reply, serialized: JSON.stringify(logs) };
}

describe("unexpected error callback", () => {
  it.each([new Error(secret), { message: secret, detail: secret, code: "23505" }, secret, null])("returns a generic500 and safe log (%#)", error => {
    const result = invoke(error);
    expect(result.reply.statusCode).toBe(500);
    expect(result.reply.body).toEqual({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
    expect(result.serialized).not.toContain(secret);
  });
  it.each([400, 401, 403, 404, 413, 415, 422, 429])("delegates intended %s errors unchanged", statusCode => {
    const error = { statusCode, message: "Expected refusal", headers: { "retry-after": "10" } };
    expect(() => invoke(error)).toThrow(error);
  });
  it("keeps a server error's503 status but not its payload", () => {
    const result = invoke({ statusCode: 503, message: secret });
    expect(result.reply.statusCode).toBe(503);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each([0, 200, 600, NaN, "400"])("treats an invalid status as500 (%s)", statusCode => {
    expect(invoke({ statusCode, message: secret }).reply.statusCode).toBe(500);
  });
  it("is installed at app construction before route plugins", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(app.indexOf("app.setErrorHandler(unexpectedErrorHandler)")).toBeGreaterThan(app.indexOf("const app = Fastify("));
    expect(app.indexOf("app.setErrorHandler(unexpectedErrorHandler)")).toBeLessThan(app.indexOf("await app.register(cookie)"));
    for (const [file, binding] of [["../src/index.ts", 'console.warn("[demo-desk] populate failed", safeError(error))'], ["../src/routes/billing.ts", "error: safeError(error), stripeEventId"]]) {
      expect(readFileSync(new URL(file!, import.meta.url), "utf8")).toContain(binding);
    }
  });
});
