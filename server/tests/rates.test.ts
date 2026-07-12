/* Rate board API tests — permission gating and the publish/read cycle. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

async function loginAs(staffId: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  const c = res.cookies.find((x) => x.name === "cdos_session")!;
  return { cdos_session: c.value };
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("rate board", () => {
  it("serves the seeded board publicly", async () => {
    const res = await app.inject({ method: "GET", url: "/api/rates" });
    expect(res.statusCode).toBe(200);
    const { board } = res.json();
    expect(board.publishedBy).toBe("seed");
    expect(board.buyMargin).toBeCloseTo(0.015);
    expect(board.rows.USD.mid).toBeCloseTo(1 / 0.7331, 4);
    expect(board.order[0]).toBe("CAD");
  });

  it("rejects publishing without a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      payload: { buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 1.37 } } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects publishing from a teller (no rates:change permission)", async () => {
    const cookies = await loginAs("a.singh");
    const res = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies,
      payload: { buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: 1.37 } } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets a branch manager publish, and the new board becomes current", async () => {
    const cookies = await loginAs("r.haddad");
    const publish = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies,
      payload: {
        buyMargin: 0.02,
        sellMargin: 0.025,
        rows: { USD: { mid: 1.372, spread: 0.01 }, EUR: { mid: 1.4712, show: false } },
        order: ["CAD", "USD", "EUR"],
      },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().board.publishedBy).toBe("r.haddad");

    const current = await app.inject({ method: "GET", url: "/api/rates" });
    const { board } = current.json();
    expect(board.rows.USD.mid).toBeCloseTo(1.372);
    expect(board.rows.USD.spread).toBeCloseTo(0.01);
    expect(board.rows.EUR.show).toBe(false);
    expect(board.sellMargin).toBeCloseTo(0.025);
  });

  it("validates the payload (negative mid rejected)", async () => {
    const cookies = await loginAs("r.haddad");
    const res = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies,
      payload: { buyMargin: 0.02, sellMargin: 0.02, rows: { USD: { mid: -5 } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps history append-only and staff-gated", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/rates/history" });
    expect(anon.statusCode).toBe(401);

    const cookies = await loginAs("j.masri");
    const res = await app.inject({ method: "GET", url: "/api/rates/history", cookies });
    expect(res.statusCode).toBe(200);
    const { publications } = res.json();
    expect(publications.length).toBeGreaterThanOrEqual(2);
    // newest first: the manager's publish precedes the seed
    expect(publications[0].publishedBy).toBe("r.haddad");
    expect(publications[publications.length - 1].publishedBy).toBe("seed");
  });
});
