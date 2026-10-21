/* A serialization failure that survives its retries is one answer on
   every route that maps it: the shared busy sentence, with no em dash
   and no en dash. The quote route used to say the post was "quoted".
   The client route used to say "saved — try again". */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { QuoteService } from "../src/quotes/service.js";
import { ClientRecordService } from "../src/clients/records.js";
import { TillControlService } from "../src/ledger/till-control.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const DASH = /[\u2013\u2014]/;
const BUSY = "The ledger is busy. Nothing was saved. Please try again.";
const busy = Object.assign(new Error("could not serialize access due to concurrent update"), {
  code: "40001",
});

let handle: DbHandle;
let app: FastifyInstance;
let cookie: string;

postgres("a retry answers with one dash-free sentence", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const session = login.cookies.find((item) => item.name === "cdos_session");
    if (!session) throw new Error("sign-in did not set a session cookie");
    cookie = session.value;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    delete process.env.DATABASE_URL;
  });

  const headers = () => ({
    cookie: `cdos_session=${cookie}`,
    "x-workspace-id": DEMO.workspaceId,
  });

  function expectBusy(res: { statusCode: number; body: string; json: () => { code?: string; message?: string } }) {
    expect(res.statusCode, res.body).toBe(409);
    const body = res.json();
    expect(JSON.stringify(body)).not.toMatch(DASH);
    expect(body).toEqual({ code: "LEDGER_BUSY", message: BUSY });
  }

  it("ledger till open", async () => {
    const open = vi.spyOn(TillControlService.prototype, "open").mockRejectedValue(busy);
    try {
      expectBusy(await app.inject({
        method: "POST",
        url: "/api/ledger/till-sessions/open",
        headers: headers(),
      }));
    } finally {
      open.mockRestore();
    }
  });

  it("quote post", async () => {
    const post = vi.spyOn(QuoteService.prototype, "post").mockRejectedValue(busy);
    try {
      expectBusy(await app.inject({
        method: "POST",
        url: "/api/quotes/quote-busy/post",
        headers: { ...headers(), "content-type": "application/json" },
        payload: {
          idempotencyKey: "busy-quote",
          purpose: "Travel",
          sourceOfFunds: "Cash",
        },
      }));
    } finally {
      post.mockRestore();
    }
  });

  it("client record create", async () => {
    const create = vi.spyOn(ClientRecordService.prototype, "create").mockRejectedValue(busy);
    try {
      expectBusy(await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: { ...headers(), "content-type": "application/json" },
        payload: { legalName: "Busy Customer" },
      }));
    } finally {
      create.mockRestore();
    }
  });
});
