/* One door for staging-only routes. Open only when STAGING is exactly
   "1" and the request Host is a real staging host. A forwarded host
   that claims staging does not open a live host. */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { stagingDoorOpen } from "../src/auth/staging-runtime.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const STAGING_HOST = "staging.currencydeskos.com";
const SERVICE_HOST = "currencydesk-staging.onrender.com";
const PREVIEW = "currencydesk-staging-pr-5.onrender.com";
const LIVE_HOSTS = ["www.currencydeskos.com", "currencydesk.onrender.com"] as const;

const saved = {
  STAGING: process.env.STAGING,
  IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
  RENDER_EXTERNAL_HOSTNAME: process.env.RENDER_EXTERNAL_HOSTNAME,
  PGLITE_MEMORY: process.env.PGLITE_MEMORY,
  SEED_PASSWORD: process.env.SEED_PASSWORD,
};

function restoreEnv() {
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreEnv);

describe("stagingDoorOpen", () => {
  it("registers routes only when the flag is exactly 1", () => {
    expect(stagingDoorOpen(undefined, { STAGING: "1" })).toBe(true);
    expect(stagingDoorOpen(undefined, {
      STAGING: "1",
      RENDER_EXTERNAL_HOSTNAME: "www.currencydeskos.com",
    })).toBe(true);
    for (const flag of [undefined, "true", " 1", "0", "1 ", ""]) {
      const env: NodeJS.ProcessEnv = { RENDER_EXTERNAL_HOSTNAME: STAGING_HOST };
      if (flag !== undefined) env.STAGING = flag;
      expect(stagingDoorOpen(undefined, env), JSON.stringify(flag)).toBe(false);
    }
  });

  it("opens only for the flag and a real staging host", () => {
    const open = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: STAGING_HOST };
    expect(stagingDoorOpen({ host: STAGING_HOST }, open)).toBe(true);
    expect(stagingDoorOpen({ host: `${STAGING_HOST}:443` }, open)).toBe(true);
    expect(stagingDoorOpen({ host: SERVICE_HOST }, {
      STAGING: "1",
      RENDER_EXTERNAL_HOSTNAME: SERVICE_HOST,
    })).toBe(true);
    expect(stagingDoorOpen({ host: PREVIEW }, {
      STAGING: "1",
      IS_PULL_REQUEST: "true",
      RENDER_EXTERNAL_HOSTNAME: PREVIEW,
    })).toBe(true);
    expect(stagingDoorOpen({ host: PREVIEW }, {
      STAGING: "1",
      RENDER_EXTERNAL_HOSTNAME: PREVIEW,
    })).toBe(false);

    for (const live of LIVE_HOSTS) {
      expect(stagingDoorOpen({ host: live }, open), live).toBe(false);
      expect(stagingDoorOpen({ host: STAGING_HOST }, {
        STAGING: "1",
        RENDER_EXTERNAL_HOSTNAME: live,
      }), live).toBe(false);
      expect(stagingDoorOpen({
        host: live,
        "x-forwarded-host": STAGING_HOST,
      }, { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: live }), `spoof ${live}`).toBe(false);
      expect(stagingDoorOpen({
        host: live,
        "x-forwarded-host": STAGING_HOST,
      }, open), `spoof against staging process ${live}`).toBe(false);
      expect(stagingDoorOpen({
        host: live,
        "x-forwarded-host": STAGING_HOST,
      }, { RENDER_EXTERNAL_HOSTNAME: live }), `flag off ${live}`).toBe(false);
    }

    expect(stagingDoorOpen({
      host: STAGING_HOST,
      "x-forwarded-host": "www.currencydeskos.com",
    }, open)).toBe(true);
    expect(stagingDoorOpen({ host: STAGING_HOST }, { RENDER_EXTERNAL_HOSTNAME: STAGING_HOST })).toBe(false);
    expect(stagingDoorOpen({ host: "" }, open)).toBe(false);
    expect(stagingDoorOpen({}, open)).toBe(false);
  });
});

describe("staging routes follow the door", () => {
  async function boot(flag: string | undefined): Promise<{ app: FastifyInstance; handle: DbHandle }> {
    restoreEnv();
    process.env.PGLITE_MEMORY = "1";
    process.env.SEED_PASSWORD = "yorkville";
    delete process.env.IS_PULL_REQUEST;
    if (flag === undefined) delete process.env.STAGING;
    else process.env.STAGING = flag;
    process.env.RENDER_EXTERNAL_HOSTNAME = STAGING_HOST;
    const handle = await createDb();
    await seed(handle.db);
    const app = await buildApp(handle.db);
    return { app, handle };
  }

  it("does not register the sign-in routes without STAGING=1", async () => {
    for (const flag of [undefined, "true", "0"]) {
      const { app, handle } = await boot(flag);
      try {
        expect(app.hasRoute({ method: "GET", url: "/api/staging/signin" }), JSON.stringify(flag)).toBe(false);
        expect(app.hasRoute({ method: "POST", url: "/api/staging/enter" }), JSON.stringify(flag)).toBe(false);
        const res = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: STAGING_HOST } });
        expect(res.statusCode, JSON.stringify(flag)).toBe(404);
      } finally {
        await app.close();
        await handle.close();
      }
    }
  }, 30_000);

  it("registers the routes when the flag is on, and a spoofed host stays 404", async () => {
    const { app, handle } = await boot("1");
    try {
      expect(app.hasRoute({ method: "GET", url: "/api/staging/signin" })).toBe(true);
      expect(app.hasRoute({ method: "POST", url: "/api/staging/enter" })).toBe(true);
      const open = await app.inject({ method: "GET", url: "/api/staging/signin", headers: { host: STAGING_HOST } });
      expect(open.statusCode).toBe(200);
      expect(open.json()).toEqual({ enabled: true });
      for (const live of LIVE_HOSTS) {
        const spoofed = await app.inject({
          method: "POST",
          url: "/api/staging/enter",
          headers: { host: live, "x-forwarded-host": STAGING_HOST },
          payload: { role: "teller" },
        });
        expect(spoofed.statusCode, live).toBe(404);
      }
    } finally {
      await app.close();
      await handle.close();
    }
  }, 30_000);
});
