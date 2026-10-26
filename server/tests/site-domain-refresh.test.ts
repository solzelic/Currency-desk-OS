/* The domain map used to reload from the tenants table every 60 seconds.
   That query never lets an idle Neon database reach its 5-minute suspend.
   A save reloads the map immediately. The safety reload waits at least
   half an hour, and a minute of clock time must not query. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Db } from "../src/db/index.js";
import {
  refreshSiteDomains,
  siteDomainRefreshIntervalMs,
  siteSlugForHost,
  startSiteDomainRefresh,
  SITE_DOMAIN_REFRESH_MAX_MS,
  SITE_DOMAIN_REFRESH_MIN_MS,
} from "../src/sites.js";

const MIN = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function countingDb(rows: () => { slug: string | null; domain: string | null }[]) {
  let calls = 0;
  const db = {
    select() {
      return {
        from() {
          return {
            where: async () => {
              calls += 1;
              return rows();
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Db, calls: () => calls };
}

describe("site domain refresh interval", () => {
  const stops: Array<() => void> = [];

  afterEach(async () => {
    for (const stop of stops) stop();
    stops.length = 0;
    vi.useRealTimers();
    await refreshSiteDomains(countingDb(() => []).db);
  });

  it("treats a missing or short setting as 30 minutes, and keeps a longer one", () => {
    expect(SITE_DOMAIN_REFRESH_MIN_MS).toBe(MIN);
    expect(siteDomainRefreshIntervalMs(undefined)).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("nope")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("0")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("1")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("29")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("30")).toBe(MIN);
    expect(siteDomainRefreshIntervalMs("45")).toBe(45 * 60 * 1000);
    expect(siteDomainRefreshIntervalMs("90.9")).toBe(90 * 60 * 1000);
    expect(SITE_DOMAIN_REFRESH_MAX_MS).toBe(DAY);
    expect(siteDomainRefreshIntervalMs("1440")).toBe(DAY);
    expect(siteDomainRefreshIntervalMs("1e9")).toBe(DAY);
    expect(siteDomainRefreshIntervalMs("Infinity")).toBe(DAY);
    expect(siteDomainRefreshIntervalMs("99999")).toBe(DAY);
  });

  it("does not query the database on a 60 second timer", async () => {
    vi.useFakeTimers();
    const rows: { slug: string | null; domain: string | null }[] = [];
    const counter = countingDb(() => rows);
    stops.push(startSiteDomainRefresh(counter.db, 60_000));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(counter.calls()).toBe(0);
    expect(siteSlugForHost("newshop.example")).toBeNull();

    rows.push({ slug: "yorkfx", domain: "newshop.example" });
    await vi.advanceTimersByTimeAsync(MIN - 60_000);
    expect(counter.calls()).toBe(1);
    expect(siteSlugForHost("newshop.example")).toBe("yorkfx");
    expect(siteSlugForHost("www.newshop.example:443")).toBe("yorkfx");
    expect(siteSlugForHost("newshop.example.")).toBe("yorkfx");
  });

  it("respects a safety interval longer than 30 minutes", async () => {
    vi.useFakeTimers();
    const counter = countingDb(() => []);
    stops.push(startSiteDomainRefresh(counter.db, siteDomainRefreshIntervalMs("45")));

    await vi.advanceTimersByTimeAsync(MIN);
    expect(counter.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(counter.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
    expect(counter.calls()).toBe(2);
  });

  it("caps a direct 1e12 delay at 24 hours", async () => {
    vi.useFakeTimers();
    const counter = countingDb(() => []);
    stops.push(startSiteDomainRefresh(counter.db, 1e12));
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(counter.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(counter.calls()).toBe(1);
  });

  it("logs a warning when a safety reload fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = {
      select() {
        return { from() { return { where: async () => { throw new Error("db down"); } }; } };
      },
    } as unknown as Db;
    stops.push(startSiteDomainRefresh(db, SITE_DOMAIN_REFRESH_MIN_MS));
    try {
      await vi.advanceTimersByTimeAsync(SITE_DOMAIN_REFRESH_MIN_MS);
      expect(warn).toHaveBeenCalledWith("[site-domains] refresh failed: db down");
    } finally {
      warn.mockRestore();
    }
  });

  it("boot does not schedule the old 60 second domain refresh", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const boot = src.slice(src.indexOf("export async function bootServer"), src.indexOf("export async function listenServer"));
    expect(boot).toContain("startSiteDomainRefresh");
    expect(boot).not.toMatch(/refreshSiteDomains\([\s\S]{0,120}60\s*\*\s*1000/);
    expect(boot).not.toMatch(/setInterval\([\s\S]{0,160}60\s*\*\s*1000/);
    const listen = src.slice(src.indexOf("export async function listenServer"));
    expect(listen).toContain("startRatesSync");
    expect(listen).not.toContain("refreshSiteDomains");
  });
});
