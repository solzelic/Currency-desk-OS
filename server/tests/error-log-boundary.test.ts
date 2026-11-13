import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isRetryable, LEDGER_BUSY_MESSAGE } from "../src/ledger/retry.js";
import { safeError } from "../src/error-boundary.js";

// Execute the actual nested failure callbacks without starting the app, a
// database, or a provider. The AST finds the declaration, including its types.
function declaration(file: string, name: string): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing ${name} in ${file}`);
  return ts.transpileModule(found.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

class LedgerError extends Error {
  constructor(readonly code: string, message: string, readonly next?: string, readonly stays?: string, readonly holderName?: string) { super(message); }
}

const secret = "SYNTHETIC-CUSTOMER-DO-NOT-LOG";
const paths = [
  ["../src/ledger/routes.ts", "failure"],
  ["../src/clients/routes.ts", "failure"],
  ["../src/quotes/routes.ts", "fail"],
] as const;

function exercise(file: string, name: string, error: unknown) {
  const logs: unknown[] = [];
  const log = (...args: unknown[]) => logs.push(args);
  const app = { log: { error: log, warn: log } };
  const reply = { status: 200, body: undefined as unknown, code(n: number) { this.status = n; return this; }, send(body: unknown) { this.body = body; return this; } };
  const fn = new Function("app", "LedgerError", "isRetryable", "LEDGER_BUSY_MESSAGE", "ID_TYPE_REFUSALS", "safeError", `${declaration(file, name)}; return ${name};`)(
    app, LedgerError, isRetryable, LEDGER_BUSY_MESSAGE, new Set(["HEALTH_CARD_NOT_ID"]), safeError,
  );
  fn(reply, error);
  return { status: reply.status, body: reply.body, log: JSON.stringify(logs) };
}

describe.each(paths)("%s failure callback", (file, name) => {
  it("does not serialize unexpected database payloads into logs or the response", () => {
    const error = Object.assign(new Error(secret), { code: "23505", detail: secret, cause: { message: secret }, query: secret, stack: secret });
    const result = exercise(file, name, error);
    expect(result.status).toBe(500);
    expect(result.body).toEqual(file.includes("quotes") ? { code: "INTERNAL_ERROR" } : { code: "INTERNAL_ERROR", message: "Unexpected server error." });
    expect(result.log).not.toContain(secret);
    expect(result.log).toContain("23505");
  });
  it.each(["40001", "40P01"])("keeps %s contention at 409 without its nested payload", code => {
    const result = exercise(file, name, Object.assign(new Error(secret), { code, detail: secret, cause: { detail: secret } }));
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ code: "LEDGER_BUSY", message: LEDGER_BUSY_MESSAGE });
    expect(result.log).not.toContain(secret);
    expect(result.log).toContain(code);
  });
  it("preserves intentional authorization refusals", () => {
    const result = exercise(file, name, new LedgerError("AUTHORIZATION_DENIED", "This action is not allowed."));
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ code: "AUTHORIZATION_DENIED", message: "This action is not allowed." });
    expect(result.log).toBe("[]");
  });
});

it("keeps client ID-type refusal fields", () => {
  const result = exercise(paths[1][0], paths[1][1], new LedgerError("HEALTH_CARD_NOT_ID", "Choose another ID."));
  expect(result.status).toBe(422);
  expect(result.body).toEqual({ error: "HEALTH_CARD_NOT_ID", detail: "Choose another ID.", code: "HEALTH_CARD_NOT_ID", message: "Choose another ID." });
});

it("keeps ledger recovery fields", () => {
  const result = exercise(paths[0][0], paths[0][1], new LedgerError("HANDOVER_APPROVAL_REQUIRED", "Approval needed.", "Ask a manager.", "Nothing changes.", "Synthetic Holder"));
  expect(result.status).toBe(403);
  expect(result.body).toEqual({ code: "HANDOVER_APPROVAL_REQUIRED", message: "Approval needed.", next: "Ask a manager.", stays: "Nothing changes.", holderName: "Synthetic Holder" });
});
