/* Persona request shape and the register-webhook command.
   Fetch is mocked. The live sandbox call runs only when
   PERSONA_SANDBOX_API_KEY is set, and it is skipped otherwise. */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personaInquiryBody, PERSONA_API_BASE_DEFAULT, PERSONA_VERSION, PERSONA_WEBHOOK_EVENTS, startPersonaCheck } from "../src/idv/providers/persona/index.js";
import { registerPersonaWebhook, STAGING_WEBHOOK_URL } from "../src/idv/register-webhook.js";

const STAGING = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com", PERSONA_API_KEY: "fixture-api-key" };
const SECRET = "fixture-signing-secret";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: {
      stdout: (line: string) => { out.push(line); },
      stderr: (line: string) => { err.push(line); },
    },
  };
}

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

function webhookFetch(list: Array<{ url: string }>, status = 201): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? String(init.body) : "", headers });
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ data: list.map((item) => ({ attributes: { url: item.url } })), links: { next: null } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: { id: "wbh_fixture", attributes: { url: STAGING_WEBHOOK_URL, secret: SECRET, secrets: [{ value: SECRET }] } },
    }), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, calls };
}

describe("persona inquiry request", () => {
  it("uses the template field the current docs name for each id", () => {
    const itmpl = JSON.parse(personaInquiryBody("itmpl_AVBb88sxEE9tJDxDPrTh54H5WGbXtm", "ref-a")) as {
      data: { attributes: Record<string, string> }; meta: Record<string, unknown>;
    };
    expect(itmpl.data.attributes["inquiry-template-id"]).toBe("itmpl_AVBb88sxEE9tJDxDPrTh54H5WGbXtm");
    expect(itmpl.data.attributes["reference-id"]).toBe("ref-a");
    expect(itmpl.meta["auto-create-account-reference-id"]).toBe("ref-a");
    const tmpl = JSON.parse(personaInquiryBody("tmpl_fixture", "ref-b")) as { data: { attributes: Record<string, string> } };
    expect(tmpl.data.attributes["template-id"]).toBe("tmpl_fixture");
    expect(tmpl.data.attributes["inquiry-template-id"]).toBeUndefined();
    const version = JSON.parse(personaInquiryBody("itmplv_fixture", "ref-c")) as { data: { attributes: Record<string, string> } };
    expect(version.data.attributes["inquiry-template-version-id"]).toBe("itmplv_fixture");
  });

  it("sends the current Persona-Version and returns only the inquiry id", async () => {
    let seen = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string>;
      expect(headers["persona-version"]).toBe(PERSONA_VERSION);
      expect(PERSONA_VERSION).toBe("2026-09-29");
      return new Response(JSON.stringify({
        data: { id: "inq_fixture", attributes: { "name-first": "Not Stored", "email-address": "secret@example.com" } },
      }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const started = await startPersonaCheck({
      referenceId: "ref-shape", shopId: "shop", branchId: "branch", tellerId: "teller",
      templateId: "itmpl_AVBb88sxEE9tJDxDPrTh54H5WGbXtm",
    }, { env: { PERSONA_API_KEY: "fixture-api-key" }, fetch: fetchImpl });
    expect(started).toEqual({ providerRef: "inq_fixture" });
    expect(seen).not.toContain("Not Stored");
    expect(seen).not.toContain("secret@example.com");
    expect(JSON.stringify(started)).not.toContain("secret@example.com");
  });
});

describe("register-webhook", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("refuses unless the runtime is staging or --production is passed", async () => {
    const cap = capture();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await registerPersonaWebhook(["register-webhook"], {}, { ...cap.io, fetch: fetchImpl })).toBe(1);
    expect(cap.err[0]).toContain("not a staging runtime");
    expect(fetchImpl).not.toHaveBeenCalled();
    const live = capture();
    const { fetch, calls } = webhookFetch([]);
    expect(await registerPersonaWebhook(["register-webhook", "--production"], { PERSONA_API_KEY: "fixture-api-key" }, { ...live.io, fetch })).toBe(0);
    expect(calls.some((call) => call.method === "POST")).toBe(true);
    expect(live.out[0]).toBe(SECRET);
  });

  it("lists first, posts the handled events, and prints the secret once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cap = capture();
    const { fetch, calls } = webhookFetch([]);
    const code = await registerPersonaWebhook(["register-webhook"], STAGING, { ...cap.io, fetch });
    expect(code).toBe(0);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${PERSONA_API_BASE_DEFAULT}/webhooks`);
    expect(calls[0]?.headers.authorization).toBe("Bearer fixture-api-key");
    expect(calls[0]?.headers["persona-version"]).toBe(PERSONA_VERSION);
    expect(calls[1]?.method).toBe("POST");
    const posted = JSON.parse(calls[1]?.body ?? "{}") as { data: { attributes: Record<string, unknown> } };
    expect(posted.data.attributes.url).toBe(STAGING_WEBHOOK_URL);
    expect(posted.data.attributes["enabled-events"]).toEqual(PERSONA_WEBHOOK_EVENTS);
    expect(PERSONA_WEBHOOK_EVENTS).toContain("inquiry.approved");
    expect(PERSONA_WEBHOOK_EVENTS).toContain("inquiry.marked-for-review");
    expect(PERSONA_WEBHOOK_EVENTS).toContain("report/watchlist.ready");
    expect(PERSONA_WEBHOOK_EVENTS).toContain("report/watchlist.matched");
    expect(PERSONA_WEBHOOK_EVENTS).not.toContain("inquiry.redacted");
    expect(posted.data.attributes["api-version"]).toBe(PERSONA_VERSION);
    expect(posted.data.attributes["api-key-inflection"]).toBe("kebab");
    expect(cap.out).toEqual([SECRET, "Paste this into PERSONA_WEBHOOK_SECRET in Render. It is shown here once and is not stored."]);
    expect(cap.out.filter((line) => line === SECRET)).toHaveLength(1);
    expect(cap.err.join("")).not.toContain(SECRET);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it("does not create a duplicate for the same URL and does not print a secret", async () => {
    const cap = capture();
    const { fetch, calls } = webhookFetch([{ url: STAGING_WEBHOOK_URL }]);
    expect(await registerPersonaWebhook(["register-webhook", "--url", STAGING_WEBHOOK_URL], STAGING, { ...cap.io, fetch })).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(cap.out).toEqual(["A webhook for this URL is already registered. Nothing was created."]);
    expect(cap.out.join("")).not.toContain(SECRET);
    expect(cap.err).toEqual([]);
  });

  it("says the key needs webhook permission and does not repeat the response", async () => {
    const cap = capture();
    const leaked = "fixture-should-not-print";
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ details: leaked }] }), { status: 403 });
    expect(await registerPersonaWebhook(["register-webhook"], STAGING, { ...cap.io, fetch: fetchImpl })).toBe(1);
    expect(cap.err).toEqual(["This API key needs webhook permission."]);
    expect(cap.out.join("") + cap.err.join("")).not.toContain(leaked);
    expect(cap.out.join("") + cap.err.join("")).not.toContain("fixture-api-key");
  });

  it("refuses when the shared key is unset", async () => {
    const cap = capture();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await registerPersonaWebhook(["register-webhook"], { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" }, { ...cap.io, fetch: fetchImpl })).toBe(1);
    expect(cap.err).toEqual(["The Persona API key is not set."]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const sandboxKey = process.env.PERSONA_SANDBOX_API_KEY;
describe.skipIf(!sandboxKey)("persona sandbox", () => {
  it("creates an inquiry on the sandbox template", async () => {
    const referenceId = `sandbox-${randomBytes(8).toString("hex")}`;
    const started = await startPersonaCheck({
      referenceId,
      shopId: "le-yorkfx-canada",
      branchId: "br-yorkville",
      tellerId: "teller",
      templateId: "itmpl_AVBb88sxEE9tJDxDPrTh54H5WGbXtm",
    }, { env: { PERSONA_API_KEY: sandboxKey } });
    expect(started.providerRef).toMatch(/^inq_/);
    expect(Object.keys(started)).toEqual(["providerRef"]);
  }, 20_000);
});
