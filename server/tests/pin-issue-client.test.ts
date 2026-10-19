/* The Employees button used to send a JSON content type and no body.
   Fastify refused that before the route ran, and the screen printed
   Bad Request. The button now sends {}. These checks fail if that
   request goes back to an empty body, or if the screen repeats the
   server's words. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "..");
const settings = readFileSync(resolve(root, "os-src/cdos-settings.jsx"), "utf8");
const messages = readFileSync(resolve(root, "os-src/pin-issue-message.js"), "utf8");
const html = readFileSync(resolve(root, "CurrencyDesk OS.html"), "utf8");

const SENTENCES = [
  "You can only issue a PIN for someone below your role.",
  "Set your own PIN from My account.",
  "That person is not on this desk.",
  "Sign in again, then issue the PIN.",
  "Only the owner or a manager can issue a PIN.",
  "The PIN was not issued. Try again.",
];

function pinIssueFailure(status: number, body: unknown): string {
  // The file is a browser script. Load the function it defines.
  // eslint-disable-next-line no-new-func
  const load = new Function(`${messages}\nreturn pinIssueFailure;`) as () => (status: number, body: unknown) => string;
  return load()(status, body);
}

function issueCall(): string {
  const at = settings.indexOf("'/api/staff/' + encodeURIComponent(loginId) + '/pin'");
  expect(at).toBeGreaterThan(0);
  return settings.slice(at, at + 1200);
}

describe("Issue a new PIN", () => {
  it("sends a JSON content type and a body of {}", () => {
    const call = issueCall();
    expect(call).toContain("'content-type': 'application/json'");
    expect(call).toContain("body: '{}'");
    expect(call).not.toMatch(/body:\s*(undefined|null|'')/);
  });

  it("loads the sentence map before the settings screen", () => {
    const msg = html.indexOf('src="os-src/pin-issue-message.js"');
    const screen = html.indexOf('src="os-src/cdos-settings.jsx"');
    expect(msg).toBeGreaterThan(0);
    expect(screen).toBeGreaterThan(msg);
  });

  it("shows a sentence, never the server's words", () => {
    const call = issueCall();
    expect(call).toContain("pinIssueFailure(res.status, d)");
    expect(call).toContain("No connection. The PIN was not issued.");
    expect(call).not.toMatch(/err:\s*[^;\n]*d\.(error|message|detail)/);
    expect(call).not.toMatch(/err:\s*[^;\n]*(err|e)\.message/);

    const cases: { status: number; body: unknown; banned: string; sentence?: string }[] = [
      {
        status: 400,
        body: { error: "Bad Request", message: "Body cannot be empty when content-type is set to 'application/json'" },
        banned: "Body cannot be empty",
        sentence: "The PIN was not issued. Try again.",
      },
      {
        status: 500,
        body: { error: "Internal Server Error", message: "Failed query: SELECT pin_hash FROM staff_users" },
        banned: "Failed query",
        sentence: "The PIN was not issued. Try again.",
      },
      {
        status: 403,
        body: { error: "role_exceeds_yours", detail: "STACK TRACE at staff.ts:524" },
        banned: "STACK TRACE",
        sentence: "You can only issue a PIN for someone below your role.",
      },
      {
        status: 403,
        body: { error: "use_set_pin", detail: "raw detail from the server" },
        banned: "raw detail",
        sentence: "Set your own PIN from My account.",
      },
      {
        status: 404,
        body: { error: "not_found", detail: "relation staff_users does not exist" },
        banned: "relation",
        sentence: "That person is not on this desk.",
      },
      {
        status: 401,
        body: { error: "unauthenticated", message: "jwt malformed eyJhbGciOiJIUzI1NiJ9" },
        banned: "eyJhbGci",
        sentence: "Sign in again, then issue the PIN.",
      },
      {
        status: 403,
        body: { error: "forbidden", detail: "permission bit 14 missing" },
        banned: "permission bit",
        sentence: "Only the owner or a manager can issue a PIN.",
      },
      {
        status: 403,
        body: { error: "something_new", message: "postgres password=secret" },
        banned: "password=secret",
      },
      {
        status: 422,
        body: { message: "Unexpected token < in JSON at position 0" },
        banned: "Unexpected token",
        sentence: "The PIN was not issued. Try again.",
      },
      { status: 200, body: null, banned: "Cannot read", sentence: "The PIN was not issued. Try again." },
      { status: 502, body: "Bad Gateway upstream timed out", banned: "Bad Gateway", sentence: "The PIN was not issued. Try again." },
    ];

    for (const row of cases) {
      const text = pinIssueFailure(row.status, row.body);
      expect(SENTENCES, JSON.stringify(row.body)).toContain(text);
      expect(text).not.toContain(row.banned);
      if (row.sentence) expect(text).toBe(row.sentence);
    }
  });
});
