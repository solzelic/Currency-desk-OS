/* The Canada pack on the screen the owner actually opens.
   York stays on version 1 until this file opts in, and the opt-in is
   put back afterwards. No deal is posted. The aggregation check uses
   rows the test invents in the browser, then asks the same engine the
   Compliance screen uses. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
    end: () => Promise<void>;
  };
};

const YORK = "le-yorkfx-canada";
let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id = 'pack-ca-v1',
            jurisdiction_pack_version = 1
      WHERE id = $1`,
    [YORK],
  );
  await pool.end();
});

test("an owner can move York onto the current Canada rules and see them", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");

  const before = await page.evaluate(async () => {
    const answer = await fetch("/api/ledger/jurisdiction").then((response) => response.json());
    const codes = (answer.reports || []).map((report: { code: string }) => report.code);
    const engine = window.CDOS._compliance;
    const regime = window.CDOS.getRegime({});
    const rows = [
      {
        id: "ca2-a", ref: "CA2-A", status: "posted", type: "Currency Exchange",
        inAmt: 12000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-10-06", time: "10:00", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
      {
        id: "ca2-b", ref: "CA2-B", status: "posted", type: "Currency Exchange",
        inAmt: 1000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-10-06", time: "11:00", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
    ];
    const clusters = engine.aggClusters(rows, regime, {});
    const night = [
      {
        id: "ca2-n1", ref: "CA2-N1", status: "posted", type: "Currency Exchange",
        inAmt: 6000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-06-15", time: "23:30", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
      {
        id: "ca2-n2", ref: "CA2-N2", status: "posted", type: "Currency Exchange",
        inAmt: 6000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-06-16", time: "00:30", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
    ];
    const nightClusters = engine.aggClusters(night, regime, { aggWindowStart: "00:00" });
    return {
      packId: answer.pack && answer.pack.packId,
      codes,
      clusters: clusters.length,
      nightCount: nightClusters.length,
      nightTotal: nightClusters[0] && nightClusters[0].total,
    };
  });
  expect(before.packId).toBe("pack-ca-v1");
  expect(before.codes).not.toContain("LVCTR");
  expect(before.codes).not.toContain("LPEPR");
  /* Version 1 leaves a receipt already at the line out of the cluster,
     so CAD 12,000 plus CAD 1,000 is not one report. */
  expect(before.clusters).toBe(0);
  /* Version 1 still adds the two CAD 6,000 receipts. A stored
     midnight anchor does not split them. */
  expect(before.nightCount).toBe(1);
  expect(before.nightTotal).toBe(12000);

  await page.getByText("Compliance").first().click();
  const win = page.locator(".win.show.active");
  await win.getByRole("button", { name: "Jurisdiction" }).click();
  await expect(win.getByText("Use the current Canada rules")).toBeVisible();
  await expect(win.getByText("Deadline not stated").first()).toBeVisible();

  await win.getByRole("button", { name: "Use the current Canada rules" }).click();
  await expect(win.getByText("LVCTR")).toBeVisible({ timeout: 20_000 });
  await expect(win.getByText("Listed Person or Entity Property Report")).toBeVisible();
  await expect(win.getByText("Within 15 calendar days")).toBeVisible();
  await expect(win.getByText("Within 5 working days").first()).toBeVisible();
  await expect(win.getByText("Immediately")).toBeVisible();
  await expect(win.getByText("as soon as practicable")).toBeVisible();
  await expect(win.getByText("every cash amount received in the rolling 24 hours, including one already at or over the line").first()).toBeVisible();
  await expect(win.getByText("cash received").first()).toBeVisible();

  const jurisdiction = await win.innerText();
  const fromActive = jurisdiction.slice(jurisdiction.indexOf("Active jurisdiction"));
  expect(fromActive).not.toMatch(/[—–]/);

  const after = await page.evaluate(async () => {
    if (window.CDOS.refreshJurisdiction) await window.CDOS.refreshJurisdiction();
    const engine = window.CDOS._compliance;
    const regime = window.CDOS.getRegime({});
    const pair = [
      {
        id: "ca2-a", ref: "CA2-A", status: "posted", type: "Currency Exchange",
        inAmt: 12000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-10-06", time: "10:00", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
      {
        id: "ca2-b", ref: "CA2-B", status: "posted", type: "Currency Exchange",
        inAmt: 1000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
        date: "2026-10-06", time: "11:00", customer: "Ada Conductor", beneficiary: "", capture: {},
      },
    ];
    const lone = [pair[0]];
    const behalf = [1, 2, 3].map((n) => ({
      id: `ca2-o${n}`, ref: `CA2-O${n}`, status: "posted", type: "Currency Exchange",
      inAmt: 4000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
      date: "2026-10-06", time: `1${n}:00`, customer: `Customer ${n}`, beneficiary: "",
      capture: { thirdPartyName: "Alex Patron" },
    }));
    const cluster = engine.aggClusters(pair, regime, {})[0];
    const behalfCluster = engine.aggClusters(behalf, regime, {}).find((item: { basis: string }) => item.basis === "on_behalf_of");
    const wall = window.CDOS.wallInstant;
    const zone = (window.CDOS.branchZone && window.CDOS.branchZone()) || "America/Toronto";
    const row = (id: string, ref: string, amount: number, date: string, time: string) => ({
      id, ref, status: "posted", type: "Currency Exchange",
      inAmt: amount, inCcy: "CAD", outAmt: 1, outCcy: "USD",
      date, time, customer: "Ada Conductor", beneficiary: "", capture: {},
    });
    const night = engine.aggClusters([
      row("ca2-n1", "CA2-N1", 6000, "2026-06-15", "23:30"),
      row("ca2-n2", "CA2-N2", 6000, "2026-06-16", "00:30"),
    ], regime, { aggWindowStart: "00:00" });
    const across = engine.aggClusters([
      row("ca2-m1", "CA2-M1", 6000, "2026-06-15", "23:59"),
      row("ca2-m2", "CA2-M2", 6000, "2026-06-16", "00:01"),
    ], regime, { aggWindowStart: "00:00" });
    const exact = engine.aggClusters([
      row("ca2-e1", "CA2-E1", 4000, "2026-06-15", "11:00"),
      row("ca2-e2", "CA2-E2", 6000, "2026-06-16", "11:00"),
    ], regime, {});
    const under = engine.aggClusters([
      row("ca2-u1", "CA2-U1", 3999.99, "2026-06-15", "11:00"),
      row("ca2-u2", "CA2-U2", 6000, "2026-06-16", "11:00"),
    ], regime, {});
    const past = engine.aggClusters([
      row("ca2-p1", "CA2-P1", 6000, "2026-06-15", "11:00"),
      row("ca2-p2", "CA2-P2", 6000, "2026-06-16", "11:01"),
    ], regime, {});
    const nightEnd = wall && wall("2026-06-16", "00:30", zone);
    const nightStart = wall && wall("2026-06-15", "00:30", zone);
    return {
      total: cluster && cluster.total,
      covered: engine.includeAllCoveredRefs(pair, regime, {}).slice().sort(),
      lone: engine.aggClusters(lone, regime, {}).length,
      behalfTotal: behalfCluster && behalfCluster.total,
      behalfCount: behalfCluster && behalfCluster.txs.length,
      nightCount: night.length,
      nightTotal: night[0] && night[0].total,
      nightStart: night[0] && night[0].windowStart,
      nightEnd: night[0] && night[0].windowEnd,
      expectStart: nightStart && nightStart.toISOString(),
      expectEnd: nightEnd && nightEnd.toISOString(),
      across: across.length,
      exact: exact.length,
      exactTotal: exact[0] && exact[0].total,
      under: under.length,
      past: past.length,
    };
  });
  expect(after.total).toBe(13000);
  expect(after.covered).toEqual(["CA2-A", "CA2-B"]);
  expect(after.lone).toBe(0);
  expect(after.behalfTotal).toBe(12000);
  expect(after.behalfCount).toBe(3);
  expect(after.nightCount).toBe(1);
  expect(after.nightTotal).toBe(12000);
  expect(after.nightStart).toBe(after.expectStart);
  expect(after.nightEnd).toBe(after.expectEnd);
  expect(after.across).toBe(1);
  expect(after.exact).toBe(1);
  expect(after.exactTotal).toBe(10000);
  expect(after.under).toBe(0);
  expect(after.past).toBe(0);
});

test("an LCTR stays on 24 hours when a stored window says otherwise", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const result = await page.evaluate(() => {
    const engine = window.CDOS._compliance;
    const live = window.CDOS.getRegime({});
    const desk = window.CDOS.deskThresholds ? window.CDOS.deskThresholds() : null;
    const saved = desk && desk.aggregationHours;
    if (desk && saved) {
      desk.aggregationHours = Object.assign({}, saved, { effective: "72", deskChoice: "72" });
    }
    const fromStore = window.CDOS.getRegime({ aggHours: 12, aggregationHours: 48, aggWindowStart: "00:00" });
    if (desk) desk.aggregationHours = saved;
    const row = (id: string, date: string, time: string) => ({
      id, ref: id, status: "posted", type: "Currency Exchange",
      inAmt: 6000, inCcy: "CAD", outAmt: 1, outCcy: "USD",
      date, time, customer: "Ada Conductor", beneficiary: "", capture: {},
    });
    const count = (hours: number, settingsHours: number, first: { date: string; time: string }, second: { date: string; time: string }) => {
      const forced = Object.assign({}, live, { aggHours: hours, largeCode: "LCTR" });
      const settings = { aggHours: settingsHours, aggregationHours: settingsHours, aggWindowStart: "00:00" };
      return engine.aggClusters([
        row("a", first.date, first.time),
        row("b", second.date, second.time),
      ], forced, settings).length;
    };
    return {
      code: fromStore.largeCode,
      hours: fromStore.aggHours,
      inside: count(12, 12, { date: "2026-06-15", time: "12:00" }, { date: "2026-06-16", time: "11:00" }),
      exact: count(72, 72, { date: "2026-06-15", time: "11:00" }, { date: "2026-06-16", time: "11:00" }),
      past: count(48, 72, { date: "2026-06-15", time: "11:00" }, { date: "2026-06-16", time: "11:01" }),
    };
  });
  expect(result.code).toBe("LCTR");
  expect(result.hours).toBe(24);
  expect(result.inside).toBe(1);
  expect(result.exact).toBe(1);
  expect(result.past).toBe(0);
});
