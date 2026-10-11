/* Cash Drawer on a phone. At 390 and 360 the count is a selector,
   steppers, and a thumb footer. At 1280 the drawer is the desktop
   one: folder tabs, small steppers, coins open, no phone selector.
   The count still posts to the ledger. */
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

/* The second drawer is inserted the same way the till-switch seam does,
   and removed afterwards, because a branch left with two tills changes
   what an unscoped ledger call means for every later spec. */
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
};
const SECOND_WORKSPACE = "ws-seam-till-02";
const SECOND_TILL = "till-02";

const PHONE = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await settled(page);
}

async function tillOpen(page: Page): Promise<void> {
  const opened = await page.evaluate(async () => {
    const seeded = await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" } }),
    });
    if (seeded.status !== 201 && seeded.status !== 409) return `balances ${seeded.status} ${await seeded.text()}`;
    const probe = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
    if (!probe.ok) return `session ${probe.status}`;
    const body = await probe.json();
    if (body.session && body.session.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (res.ok || res.status === 409) return "open";
    return `${res.status} ${await res.text()}`;
  });
  expect(opened, "the populated book did not open a till").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await settled(page);
}

async function openTill(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('#phonebar [data-phone-app="till"]').click();
  } else {
    await page.locator('#appbar [data-app="till"]').click();
  }
  await dismissTour(page);
  await settled(page);
  await expect(page.locator(".till-root")).toBeVisible();
  await expect(page.getByText("server balances unavailable")).toHaveCount(0);
  await expect(page.getByText("This till hasn’t been opened")).toHaveCount(0);
}

/* A sideways page is a failure. A table may scroll inside its own box. */
async function overflowPast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const seen: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      let node: HTMLElement | null = el.parentElement;
      let contained = false;
      while (node && node !== document.body) {
        const parent = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const scrolls = parent.overflowX === "auto" || parent.overflowX === "scroll";
        if (scrolls && box.right <= limit + 1 && box.left >= -1) {
          contained = true;
          break;
        }
        node = node.parentElement;
      }
      if (rect.right > limit && !contained) {
        const name = (el.id ? "#" + el.id : el.tagName.toLowerCase()) + "." + String(el.className).slice(0, 40);
        seen.push(name + " right=" + Math.round(rect.right));
        if (seen.length >= 6) break;
      }
    }
    return seen;
  });
}

async function countCad(page: Page): Promise<void> {
  const add = page.getByRole("button", { name: "Add one $100 CAD" });
  await add.click();
  await add.click();
  await expect(page.getByRole("spinbutton", { name: "$100 CAD count" })).toHaveValue("2");
  await expect(page.locator(".till-den").first().locator(".till-den-sub")).toHaveText("200");
  await expect(page.locator(".till-counted-input")).toHaveValue("200");
}

test("a phone can count, save, and reach every till tab", async ({ page }) => {
  test.setTimeout(180_000);
  for (const size of PHONE) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await atDesk(page);
    await tillOpen(page);
    await openTill(page, true);

    await expect(page.locator(".till-phone-who")).toContainText("On the drawer");
    await expect(page.locator(".till-phone-who")).toContainText("A. Singh");
    await expect(page.locator(".till-phone-who")).toContainText("Senior teller");
    /* One till keeps the plain local name. The day-at-the-desk spec
       leaves its own till on this branch, so a full-suite run already
       has a switcher here and the name is the ledger till. */
    const switcher = page.locator(".till-phone-till");
    if (await switcher.count()) {
      await expect(switcher).toContainText("till-01");
    } else {
      await expect(page.locator(".till-phone-who")).toContainText("Till 1");
      await expect(switcher).toHaveCount(0);
    }
    const whoLine = await page.locator(".till-phone-bit").evaluateAll((els) => {
      const tops = els.map((el) => Math.round(el.getBoundingClientRect().top));
      const host = els[0]?.parentElement;
      return {
        tops,
        clipped: !!host && host.scrollWidth > host.clientWidth + 1,
      };
    });
    expect(new Set(whoLine.tops).size, "the who-line wraps onto a second line").toBe(1);
    expect(whoLine.clipped, "the who-line clips").toBe(false);

    const session = page.locator(".till-session");
    await expect(session).toBeVisible();
    await expect(session).toContainText(/Session #\d+/);
    await expect(session).toContainText("open");
    await expect(session).toContainText("opened by");
    const sessionCut = await session.evaluate((el) => {
      const over = (node: Element | null) => !!node && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
      return {
        line: over(el.querySelector(".till-session-line")),
        tally: over(el.querySelector(".till-session-tally")),
        box: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      };
    });
    expect(sessionCut, "the session line is cut off at " + size.width).toEqual({ line: false, tally: false, box: false });
    await expect(page.locator(".till-pill")).toBeVisible();
    const pillClipped = await page.locator(".till-pill").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(pillClipped, "In drawer wraps or clips").toBe(false);

    const past = await overflowPast(page);
    expect(past, "horizontal overflow at " + size.width).toEqual([]);
    await expect(page.locator(".win.show.active .win-resize")).toBeHidden();

    const chip = await page.locator(".till-chip").first().boundingBox();
    expect(chip && chip.height).toBeGreaterThanOrEqual(44);
    /* A saved count comes back as a total. The steppers are the
       denomination count, so open that mode when the total is showing. */
    await expect(page.locator(".till-total-card, .till-den").first()).toBeVisible();
    if (await page.locator(".till-total-card").isVisible()) {
      await page.getByRole("button", { name: "Count denominations" }).click();
    }
    const step = await page.locator(".till-den .till-step").first().boundingBox();
    expect(step && step.width).toBeGreaterThanOrEqual(44);
    expect(step && step.height).toBeGreaterThanOrEqual(44);
    const whoSize = await page.locator(".till-phone-who").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(whoSize).toBeGreaterThanOrEqual(15);

    await expect(page.locator(".till-coins")).toBeHidden();
    await page.locator(".till-coins-btn").click();
    await expect(page.locator(".till-coins")).toBeVisible();
    await page.locator(".till-coins-btn").click();

    await countCad(page);
    await page.locator(".till-chip", { hasText: "USD" }).click();
    if (await page.locator(".till-total-card").isVisible()) {
      await page.getByRole("button", { name: "Count denominations" }).click();
    }
    await page.getByRole("button", { name: "Add one $50 USD" }).click();
    await expect(page.locator(".till-counted-input")).toHaveValue("50");

    const posted = page.waitForResponse((r) => r.url().includes("/api/ledger/till-counts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save count" }).click();
    const res = await posted;
    expect(res.ok(), await res.text()).toBeTruthy();
    const tally = await page.evaluate(async () => {
      const r = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
      return r.json();
    });
    const counts = tally.latestCounts || {};
    expect(Object.keys(counts).sort()).toEqual(expect.arrayContaining(["CAD", "USD"]));
    expect(Number(counts.CAD.counted)).toBe(200);
    expect(Number(counts.USD.counted)).toBe(50);

    await page.locator(".till-phone-select").click();
    await expect(page.locator(".till-sheet")).toBeVisible();
    await page.locator(".till-sheet").getByRole("button", { name: "Reconcile & close" }).click();
    await expect(page.locator(".till-table-scroll")).toBeVisible();
    await expect(page.locator(".till-table-scroll tbody tr").filter({ hasText: "CAD" }).first()).toContainText("200");
    await expect(page.locator(".till-table-scroll tbody tr").filter({ hasText: "USD" }).first()).toContainText("50");
    const reconPast = await overflowPast(page);
    expect(reconPast, "reconcile overflow").toEqual([]);

    await page.locator(".till-phone-select").click();
    await page.locator(".till-sheet").getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Shift handoffs")).toBeVisible();
    const histPast = await overflowPast(page);
    expect(histPast, "history overflow").toEqual([]);

    await page.locator(".till-phone-select").click();
    await page.locator(".till-sheet").getByRole("button", { name: "Cash drawer", exact: true }).click();
    await expect(page.locator(".till-counted-input")).toBeVisible();

    const hand = await page.locator(".till-handoff-phone").boundingBox();
    const saveBox = await page.getByRole("button", { name: "Save count" }).boundingBox();
    expect(hand && hand.height).toBeGreaterThanOrEqual(44);
    expect(saveBox && saveBox.height).toBeGreaterThanOrEqual(44);
    expect(hand && saveBox && Math.abs(hand.y - saveBox.y)).toBeLessThan(8);
    /* The round + is hidden on Till. The footer sits on the tab bar. */
    await expect(page.locator("#phone-fab")).toBeHidden();
    const footerGap = await page.evaluate(() => {
      const foot = document.querySelector(".till-foot");
      const bar = document.querySelector("#phonebar");
      if (!(foot instanceof HTMLElement) || !(bar instanceof HTMLElement)) return null;
      return Math.round(bar.getBoundingClientRect().top - foot.getBoundingClientRect().bottom);
    });
    expect(footerGap, "Hand off / Save count sits on the bottom bar").toBeGreaterThanOrEqual(0);
    expect(footerGap, "Hand off / Save count sits on the bottom bar").toBeLessThanOrEqual(2);
    const timeLines = await page.locator(".till-session-when").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
      return box.height <= line * 1.4;
    });
    expect(timeLines, "the session clock breaks onto its own line").toBe(true);

    const expected = page.locator(".till-expected-fig");
    const blurred = await expected.evaluate((el) => getComputedStyle(el).filter.includes("blur"));
    expect(blurred).toBe(true);
    await page.locator(".till-expected").click();
    await expect(expected).not.toHaveClass(/is-blind/);
    await expect.poll(async () => expected.evaluate((el) => getComputedStyle(el).filter.includes("blur"))).toBe(false);
  }
});

test("the desktop cash drawer is unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await tillOpen(page);
  await openTill(page, false);

  await expect(page.locator(".till-phone-select")).toBeHidden();
  await expect(page.locator(".till-phone-who")).toBeHidden();
  await expect(page.locator(".till-coins-btn")).toBeHidden();
  await expect(page.locator(".till-handoff-phone")).toBeHidden();
  await expect(page.locator(".till-sheet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cash drawer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconcile & close", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "History", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Count denominations" }).click();
  await expect(page.locator(".till-coins")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hand off" })).toBeVisible();

  const step = await page.locator(".till-den .till-step").first().boundingBox();
  expect(Math.round(step?.width || 0)).toBe(26);
  expect(Math.round(step?.height || 0)).toBe(28);
  await expect(page.locator(".win.show.active .win-bar")).toBeVisible();
  await expect(page.locator(".win.show.active .win-resize")).toBeVisible();
  await expect(page.locator(".till-session")).toBeVisible();
  /* Mounted only at phone width, so a wide window still has the one
     header switcher. */
  await expect(page.locator(".till-phone-till")).toHaveCount(0);
});

/* The who-line used to be one nowrap row, so a long name ran off a
   360px screen. The bits wrap at the dots. The name ellipsizes only
   when that one bit is wider than the screen. */
test("a long who-line stays on a 360px screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await atDesk(page);
  await tillOpen(page);
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    const employees = Array.isArray(settings.employees) ? settings.employees : [];
    settings.employees = employees.map((employee: { code?: string; staffId?: string; name?: string }) => {
      if (employee.code === "a.singh" || employee.staffId === "a.singh" || employee.name === "A. Singh") {
        return { ...employee, name: "Alexandra Konstantinou", role: "Assistant branch manager" };
      }
      return employee;
    });
    localStorage.setItem("cdos_settings", JSON.stringify(settings));
    const branches = JSON.parse(localStorage.getItem("cdos_stations_v2") || "null");
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        for (const till of branch.tills || []) {
          if (till.id === "b01t1") {
            till.name = "Till 12";
            till.teller = "Alexandra Konstantinou";
          }
        }
      }
      localStorage.setItem("cdos_stations_v2", JSON.stringify(branches));
    }
  });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await settled(page);
  await openTill(page, true);

  const who = page.locator(".till-phone-who");
  await expect(who).toContainText("Alexandra Konstantinou");
  await expect(who).toContainText("Assistant branch manager");
  await expect(who).toContainText("On the drawer");
  /* Till 12 is the local name, and it shows when this branch has one
     till. Another till already on the book replaces it with the
     ledger id, which is the name the switcher opens. */
  if (await page.locator(".till-phone-till").count()) {
    await expect(page.locator(".till-phone-till")).toBeVisible();
  } else {
    await expect(who).toContainText("Till 12");
  }
  const laid = await who.evaluate((host) => {
    const hostBox = host.getBoundingClientRect();
    const bits = [...host.querySelectorAll(".till-phone-bit")];
    const lineStarts = bits.filter((bit) => bit.getBoundingClientRect().left <= hostBox.left + 2);
    const dotInside = bits.map((bit) => {
      const box = bit.getBoundingClientRect();
      const style = getComputedStyle(bit, "::before");
      if (!style.content || style.content === "none" || style.content === "normal") return false;
      const left = box.left + (parseFloat(style.left) || 0);
      const right = left + (parseFloat(style.width) || 0);
      const startsLine = box.left <= hostBox.left + 2;
      return startsLine && right > hostBox.left + 1;
    });
    const name = host.querySelector(".till-phone-name");
    const lead = host.querySelector(".till-phone-lead");
    return {
      bits: bits.length,
      lineStarts: lineStarts.map((bit) => (bit.textContent || "").trim()),
      dotInside,
      nameCut: !!name && name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow !== "ellipsis",
      leadCut: !!lead && lead.scrollWidth > lead.clientWidth + 1,
      hostCut: host.scrollWidth > host.clientWidth + 1,
    };
  });
  expect(laid.bits).toBe(3);
  expect(laid.lineStarts.every((text) => !text.startsWith("·") && !text.endsWith("·"))).toBe(true);
  expect(laid.dotInside.every((inside) => inside === false)).toBe(true);
  expect(laid.nameCut, "the name is clipped without an ellipsis").toBe(false);
  expect(laid.leadCut, "On the drawer is clipped").toBe(false);
  expect(laid.hostCut, "the who-line clips").toBe(false);
  const past = await overflowPast(page);
  expect(past, "horizontal overflow").toEqual([]);
});

test("a phone shows a closed session in full", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await atDesk(page);
  await tillOpen(page);
  await openTill(page, true);
  const closed = await page.evaluate(async () => {
    const balances = await fetch("/api/ledger/till-balances", { credentials: "same-origin" }).then((r) => r.json());
    const current = await fetch("/api/ledger/till-session", { credentials: "same-origin" }).then((r) => r.json());
    const res = await fetch("/api/ledger/till-sessions/" + encodeURIComponent(current.session.sessionId) + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        idempotencyKey: "phone-layout-close-" + Date.now(),
        counts: balances.balances,
        note: "Counted and locked for the night",
      }),
    });
    return { status: res.status, text: res.ok ? "" : await res.text() };
  });
  expect(closed.status, closed.text).toBe(200);
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await settled(page);
  await openTill(page, true);
  const session = page.locator(".till-session");
  await expect(session).toBeVisible();
  await expect(session).toContainText(/Session #\d+/);
  await expect(session).toContainText("closed by");
  await expect(session).toContainText("Counted and locked for the night");
  const cut = await session.evaluate((el) => {
    const line = el.querySelector(".till-session-line");
    return {
      line: !!line && (line.scrollWidth > line.clientWidth + 1 || line.scrollHeight > line.clientHeight + 1),
      box: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
    };
  });
  expect(cut, "the closed session is cut off").toEqual({ line: false, box: false });
  const past = await overflowPast(page);
  expect(past, "horizontal overflow").toEqual([]);
  await page.evaluate(async () => {
    await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
  });
});

test("a phone can move to the other till", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the second till is a ledger workspace");
  test.setTimeout(180_000);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
       VALUES ($1,'tnt-yorkfx','le-yorkfx-canada','br-yorkville',$2) ON CONFLICT DO NOTHING`,
      [SECOND_WORKSPACE, SECOND_TILL],
    );
    for (const size of PHONE) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await atDesk(page);
      await tillOpen(page);
      const seeded = await page.evaluate(async (workspaceId) => {
        const r = await fetch("/api/ledger/opening-balances", {
          method: "POST",
          headers: { "content-type": "application/json", "x-workspace-id": workspaceId },
          credentials: "same-origin",
          body: JSON.stringify({ balances: { CAD: "9000.00" } }),
        });
        return r.status;
      }, SECOND_WORKSPACE);
      expect([201, 409]).toContain(seeded);
      await openTill(page, true);

      await expect(page.locator(".till-ambiguous-inscroll")).toContainText("Tap the till name");
      await expect(page.locator(".till-ambiguous-inscroll b")).toHaveText("till-01");
      const opener = page.locator(".till-phone-till");
      await expect(opener).toBeVisible();
      await expect(opener).toContainText("till-01");
      await opener.click();
      const sheet = page.getByRole("dialog", { name: "Switch till" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("button", { name: /till-01/ })).toBeVisible();
      await expect(sheet.getByRole("button", { name: /till-02/ })).toBeVisible();
      await sheet.getByRole("button", { name: /till-02/ }).click();
      await page.getByRole("button", { name: /^Switch till$/ }).click();

      await expect(page.locator(".till-phone-till")).toContainText(SECOND_TILL);
      await expect(page.locator(".till-ambiguous-inscroll b")).toHaveText(SECOND_TILL);
      await expect(page.getByText(/Now counting till-02/)).toBeVisible();
      await expect.poll(async () => page.evaluate(async () => {
        const r = await fetch("/api/ledger/till-balances", { credentials: "same-origin" });
        const body = await r.json();
        return body.tillId as string;
      })).toBe(SECOND_TILL);
      const past = await overflowPast(page);
      expect(past, "horizontal overflow at " + size.width).toEqual([]);
    }
  } finally {
    await pool.query("DELETE FROM sessions WHERE workspace_id = $1", [SECOND_WORKSPACE]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [SECOND_WORKSPACE]);
    await pool.end();
  }
});
