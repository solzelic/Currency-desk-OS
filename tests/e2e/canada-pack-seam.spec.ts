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
    return { packId: answer.pack && answer.pack.packId, codes, clusters: clusters.length };
  });
  expect(before.packId).toBe("pack-ca-v1");
  expect(before.codes).not.toContain("LVCTR");
  expect(before.codes).not.toContain("LPEPR");
  /* Version 1 leaves a receipt already at the line out of the cluster,
     so CAD 12,000 plus CAD 1,000 is not one report. */
  expect(before.clusters).toBe(0);

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
  await expect(win.getByText("every amount in the static window, including one already over the line").first()).toBeVisible();
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
    return {
      total: cluster && cluster.total,
      covered: engine.includeAllCoveredRefs(pair, regime, {}).slice().sort(),
      lone: engine.aggClusters(lone, regime, {}).length,
      behalfTotal: behalfCluster && behalfCluster.total,
      behalfCount: behalfCluster && behalfCluster.txs.length,
    };
  });
  expect(after.total).toBe(13000);
  expect(after.covered).toEqual(["CA2-A", "CA2-B"]);
  expect(after.lone).toBe(0);
  expect(after.behalfTotal).toBe(12000);
  expect(after.behalfCount).toBe(3);
});
