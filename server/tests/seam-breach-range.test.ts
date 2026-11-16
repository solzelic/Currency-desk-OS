import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkPassword, pwnedRange } from "../src/onboarding/password-rule.js";
import { seamBreachFetch, SEAM_BREACHED_PASSWORD, SEAM_UNAVAILABLE_PASSWORD } from "../src/seam-breach-range.js";

const local = { NODE_ENV: "development", HOST: "127.0.0.1", DATABASE_URL: "postgres://test@localhost/seam" };
const rangeUrl = "https://api.pwnedpasswords.com/range/ABCDE";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local signup breach-range seam", () => {
  it("runs the actual password checker with clean, breached and unavailable responses without network", async () => {
    const upstream = vi.fn<typeof fetch>(async () => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", seamBreachFetch(upstream, local));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkPassword("harbour tide lantern 42", "Synthetic Shop")).toEqual({ ok: true });
    expect(await checkPassword(SEAM_BREACHED_PASSWORD, "Synthetic Shop")).toMatchObject({ ok: false, reason: "breached" });
    expect(await checkPassword(SEAM_UNAVAILABLE_PASSWORD, "Synthetic Shop")).toMatchObject({ ok: false, reason: "check_unavailable" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { NODE_ENV: "production" }, { STAGING: "1" }, { RENDER: "true" },
    { RENDER_SERVICE_ID: "srv-synthetic" }, { RENDER_EXTERNAL_HOSTNAME: "staging.example" },
    { HOST: "0.0.0.0" }, { DATABASE_URL: "postgres://test@remote.example/seam" },
    { DATABASE_URL: "postgres://test@localhost/seam?host=remote.example" },
  ])("does not replace real checking outside local test runtime: %j", async (override) => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", seamBreachFetch(upstream, { ...local, ...override }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkPassword("harbour tide lantern 42", "Synthetic Shop")).toMatchObject({ ok: false, reason: "check_unavailable" });
    const digest = createHash("sha1").update("harbour tide lantern 42").digest("hex").toUpperCase();
    expect(upstream).toHaveBeenCalledWith(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("passes unrelated requests through with the original arguments", async () => {
    const response = new Response("unchanged"), upstream = vi.fn<typeof fetch>(async () => response);
    const fetcher = seamBreachFetch(upstream, local);
    for (const url of ["https://example.test/range/ABCDE", "https://api.pwnedpasswords.com/other", rangeUrl + "?extra=1"]) {
      const init = { headers: { "x-test": "synthetic" } };
      expect(await fetcher(url, init)).toBe(response);
      expect(upstream).toHaveBeenLastCalledWith(url, init);
    }
    expect(await fetcher(rangeUrl, { method: "POST" })).toBe(response);
  });

  it("requires explicit local-staging opt-in and still refuses deployed or remote runtimes", async () => {
    const env = { ...local, STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "staging.currencydeskos.com", CD_TEST_BREACH_RANGE: "local-staging" };
    const upstream = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    expect((await seamBreachFetch(upstream, env)(rangeUrl)).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
    for (const override of [
      { CD_TEST_BREACH_RANGE: "1" }, { NODE_ENV: "production" }, { RENDER: "true" },
      { RENDER_SERVICE_ID: "srv-test" }, { HOST: "0.0.0.0" },
      { RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" },
      { DATABASE_URL: "postgres://test@remote.example/seam" },
      { DATABASE_URL: "postgres://test@localhost/seam?host=remote.example" },
    ]) expect((await seamBreachFetch(upstream, { ...env, ...override })(rangeUrl)).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(8);
  });

  it("honours cancellation and rechecks the runtime gate for every request", async () => {
    const env = { ...local }, upstream = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    const fetcher = seamBreachFetch(upstream, env);
    const controller = new AbortController(); controller.abort();
    await expect(fetcher(new Request(rangeUrl, { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(upstream).not.toHaveBeenCalled();
    env.NODE_ENV = "production";
    expect((await fetcher(rangeUrl)).status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("leaves production timeout failures fail-closed", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Exercise the production 3-second abort signal, without an external request.
    expect(await checkPassword("harbour tide lantern 42", "Synthetic Shop", pwnedRange))
      .toMatchObject({ ok: false, reason: "check_unavailable" });
  });
});
