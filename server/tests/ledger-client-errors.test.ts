/* A failed ledger read used to say "Nothing was posted."

   That sentence is for a write the book refused. A balance or a
   client list that did not load is a different fact, and the person
   at the desk was being told the wrong one.

   The sentences live in os-src/cdos-backend.js. This loads that file
   and calls it, the same way the tour tests load the tour, so a copy
   of the wording in the test cannot stay green after the client
   changes. A network failure and a refusal with no known code are
   the two ways a call fails before any of the named codes apply.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const READ_OFFLINE = "CurrencyDesk could not reach the ledger server. Try again.";
const WRITE_OFFLINE = "CurrencyDesk could not reach the ledger server. Nothing was posted.";
const READ_REFUSED = "The desk could not load that. Try again.";
const WRITE_REFUSED = "The ledger server rejected this request. Nothing was posted.";

interface LedgerClient {
  request: (path: string, options?: { method?: string; body?: string }) => Promise<unknown>;
}

function loadClient(fetchImpl: typeof fetch): LedgerClient {
  const src = readFileSync(resolve(process.cwd(), "../os-src/cdos-backend.js"), "utf8");
  const win: { CDOS?: { Backend: LedgerClient } } = {};
  // eslint-disable-next-line no-new-func
  new Function("window", "fetch", src)(win, fetchImpl);
  if (!win.CDOS) throw new Error("the ledger client did not attach itself to window.CDOS");
  return win.CDOS.Backend;
}

async function failureMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the ledger client treated a failed call as a success");
}

describe("a failed ledger read is not told as a refused write", () => {
  it("uses the read sentence when the server cannot be reached, and still says nothing was posted for a write", async () => {
    const client = loadClient(() => Promise.reject(new Error("offline")));
    const get = await failureMessage(() => client.request("/api/ledger/till-balances"));
    const head = await failureMessage(() => client.request("/api/ledger/till-balances", { method: "HEAD" }));
    const post = await failureMessage(() => client.request("/api/ledger/till-movements", { method: "POST", body: "{}" }));
    expect({ get, head, post }).toEqual({ get: READ_OFFLINE, head: READ_OFFLINE, post: WRITE_OFFLINE });
    expect(get).not.toContain("Nothing was posted.");
    expect(head).not.toContain("Nothing was posted.");
  });

  it("uses the read sentence when the response is not ok and the code is not a known one, and still says nothing was posted for a write", async () => {
    const client = loadClient(() => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ code: "NOT_A_KNOWN_CODE" }),
    } as unknown as Response));
    const get = await failureMessage(() => client.request("/api/ledger/vault"));
    const head = await failureMessage(() => client.request("/api/ledger/vault", { method: "HEAD" }));
    const post = await failureMessage(() => client.request("/api/quotes", { method: "POST", body: "{}" }));
    expect({ get, head, post }).toEqual({ get: READ_REFUSED, head: READ_REFUSED, post: WRITE_REFUSED });
    expect(get).not.toContain("Nothing was posted.");
    expect(head).not.toContain("Nothing was posted.");
  });
});
