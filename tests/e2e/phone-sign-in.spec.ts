/* Phone shop sign-in. Under 430px the desk asks for the staff ID and
   the password on one screen, then the emailed code. A wide window
   keeps the screen it already had.

   The password is never written to storage. The staff ID is. The code
   is sent once when the sixth digit lands, even if the field reports
   that value twice. Pasting six digits fills every box and sends once. */
import { mkdirSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { test, expect, codeFor, logSize } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/* 6×44 + 5×8 = 304. Centered, that row fits a 360px phone with the
   16px gutter, and neither end box may sit outside the viewport. */
async function assertCodeBoxes(page: Page): Promise<void> {
  const report = await page.locator("#lock.si-phone .si-code").evaluate((row) => {
    const rowStyle = getComputedStyle(row);
    const rowBox = row.getBoundingClientRect();
    const input = row.querySelector("input");
    const inputStyle = input ? getComputedStyle(input) : null;
    const boxes = [...row.querySelectorAll("i")].map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      let clipped = false;
      let n: HTMLElement | null = el.parentElement;
      while (n) {
        const ns = getComputedStyle(n);
        const clips = (v: string) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
        if (clips(ns.overflowX) || clips(ns.overflowY)) {
          const p = n.getBoundingClientRect();
          if (r.left < p.left - 0.5 || r.right > p.right + 0.5 || r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5) {
            clipped = true;
            break;
          }
        }
        n = n.parentElement;
      }
      return {
        w: r.width,
        h: r.height,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        border: s.borderTopWidth,
        radius: s.borderTopLeftRadius,
        weight: s.fontWeight,
        size: s.fontSize,
        line: s.lineHeight,
        nums: s.fontVariantNumeric,
        outline: s.outlineStyle,
        shadow: s.boxShadow,
        cur: el.classList.contains("cur"),
        clipped,
      };
    });
    return {
      gap: rowStyle.columnGap,
      rowW: rowBox.width,
      rowLeft: rowBox.left,
      outline: rowStyle.outlineStyle,
      shadow: rowStyle.boxShadow,
      overflow: rowStyle.overflowX,
      inputOutline: inputStyle ? inputStyle.outlineStyle : "",
      inputShadow: inputStyle ? inputStyle.boxShadow : "",
      vw: window.innerWidth,
      vh: window.innerHeight,
      boxes,
    };
  });

  expect(report.gap).toBe("8px");
  expect(report.rowW).toBeCloseTo(304, 0);
  expect(report.rowLeft).toBeCloseTo((report.vw - 304) / 2, 0);
  expect(report.outline).toBe("none");
  expect(report.shadow).toBe("none");
  expect(report.overflow).toBe("visible");
  expect(report.inputOutline).toBe("none");
  expect(report.inputShadow).toBe("none");
  expect(report.boxes).toHaveLength(6);
  expect(report.boxes.filter((b) => b.cur)).toHaveLength(1);
  for (const box of report.boxes) {
    expect(box.w).toBeCloseTo(44, 0);
    expect(box.h).toBeCloseTo(56, 0);
    expect(box.border).toBe("1px");
    expect(box.radius).toBe("10px");
    expect(box.size).toBe("24px");
    expect(box.line).toBe("32px");
    expect(box.weight).toBe("600");
    expect(box.nums).toContain("tabular-nums");
    expect(box.outline).toBe("none");
    expect(box.left).toBeGreaterThanOrEqual(-0.5);
    expect(box.right).toBeLessThanOrEqual(report.vw + 0.5);
    expect(box.top).toBeGreaterThanOrEqual(-0.5);
    expect(box.bottom).toBeLessThanOrEqual(report.vh + 0.5);
    expect(box.clipped, `box at ${box.left}`).toBe(false);
    if (box.cur) expect(box.shadow).toBe("rgb(30, 90, 168) 0px 0px 0px 2px");
    else expect(box.shadow).toBe("none");
  }
}

async function pasteCode(page: Page, digits: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async (digits) => {
    await navigator.clipboard.writeText(digits);
  }, digits);
  await page.locator("#si-code").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+V");
}

async function phone(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.locator("#si-id")).toBeVisible();
  await expect(page.getByText("Brand mark is a placeholder")).toHaveCount(0);
}

/* The wide screen is still the old card. The pixel check is
   tests/e2e/desktop-unchanged.spec.ts (sign-in-1280.png). This
   test only checks that the phone tree is not mounted. */
test("desktop sign-in at 1280 is the wide screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await expect(page.getByText("CURRENCYDESK ID")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue/ })).toBeVisible();
  await expect(page.locator("[data-phone-signin]")).toHaveCount(0);
  await expect(page.getByText("Staff ID", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Brand mark is a placeholder")).toHaveCount(0);
  const h1 = await page.locator("#lock h1").evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, align: s.textAlign, weight: s.fontWeight };
  });
  expect(h1).toEqual({ size: "23px", align: "center", weight: "800" });
});

for (const width of [360, 390]) {
  test.describe(`phone sign-in at ${width}`, () => {
    test("remembers the staff ID and not the password", async ({ page }) => {
      await phone(page, width);
      await expect(page.locator("#si-id")).toHaveAttribute("autocomplete", "username");
      await expect(page.locator("#si-pw")).toHaveAttribute("autocomplete", "current-password");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
      await page.locator("#si-id").fill("a.singh");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
      await page.locator("#si-pw").fill("yorkville");
      await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.locator("[data-phone-signin]")).toHaveCount(0, { timeout: 45_000 });

      const bag = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) out[k] = localStorage.getItem(k) || "";
        }
        return out;
      });
      expect(bag.phone_staff_id).toBe("a.singh");
      /* cdos_* and yorkfx_* are the desk document. A device note under
         those names is wiped or copied to every till when the desk loads. */
      expect("phone_staff_id").not.toMatch(/^(cdos_|yorkfx_)/);
      expect(bag.phone_tab).toBe("rates");
      /* The seeded rate board stores the branch id br-yorkville. That is
         not the password. The password itself is never a stored value. */
      for (const [key, value] of Object.entries(bag)) {
        expect(value, key).not.toBe("yorkville");
      }

      await page.context().clearCookies();
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await expect(page.locator("#si-id")).toHaveValue("a.singh");
      await expect(page.locator("#si-pw")).toHaveValue("");
      await page.getByRole("button", { name: "Not you?" }).click();
      await expect(page.locator("#si-id")).toHaveValue("");
      expect(await page.evaluate(() => localStorage.getItem("phone_staff_id"))).toBeNull();
    });

    test("a wrong password is the plain sentence, and the ID stays", async ({ page }) => {
      await phone(page, width);
      await page.locator("#si-id").fill("asingh");
      await page.locator("#si-pw").fill("not-the-password");
      await shot(page, `signin_sign-in_${width}`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("That password does not match this staff ID. Check caps lock and try again.")).toBeVisible();
      await expect(page.locator("#si-id")).toHaveValue("asingh");
      await expect(page.locator("#si-pw")).toHaveValue("");
      await expect(page.locator("#si-pw")).toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem("phone_staff_id"))).toBeNull();
      await shot(page, `signin_error_${width}`);

      await page.locator("#si-id").fill("nobody-on-this-desk");
      await page.locator("#si-pw").fill("still-wrong");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText("That password does not match this staff ID. Check caps lock and try again.")).toBeVisible();
    });

    test("the waking note appears only after the server has been quiet", async ({ page }) => {
      await phone(page, width);
      await page.route("**/api/auth/login/start", async (route) => {
        await new Promise((r) => setTimeout(r, 4500));
        await route.continue();
      });
      await page.locator("#si-id").fill("a.singh");
      await page.locator("#si-pw").fill("not-the-password");
      const started = Date.now();
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
      const waking = page.getByText("can take up to a minute");
      await expect(waking).toBeVisible({ timeout: 8000 });
      expect(Date.now() - started).toBeGreaterThan(2500);
      await shot(page, `signin_waking_${width}`);
      await expect(waking).toBeHidden({ timeout: 8000 });
      await expect(page.getByText("That password does not match this staff ID. Check caps lock and try again.")).toBeVisible();
    });

    test("the code submits once, and a wrong code is the plain sentence", async ({ page }) => {
      await phone(page, width);
      const email = `teller-${width}-${Date.now()}@yorkfx.example`;
      const password = "counter-pass-2026";
      const made = await page.evaluate(async ({ email, password }) => {
        const login = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" }),
        });
        if (!login.ok) return { ok: false, status: login.status, step: "login" };
        const res = await fetch("/api/staff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ staffId: email, name: "Floor Teller", role: "teller", password }),
        });
        let body: unknown = null;
        try { body = await res.json(); } catch (e) { body = { parse: String(e) }; }
        return { ok: res.ok, status: res.status, body };
      }, { email, password });
      expect(made.ok, JSON.stringify(made)).toBeTruthy();

      await page.context().clearCookies();
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.reload();
      await page.locator("#si-id").fill(email);
      await page.locator("#si-pw").fill(password);
      const since = logSize();
      let hits = 0;
      let releaseVerify: (() => void) | null = null;
      let holdVerify = false;
      await page.route("**/api/auth/login/verify", async (route) => {
        hits += 1;
        if (holdVerify) await new Promise<void>((resolve) => { releaseVerify = resolve; });
        await route.continue();
      });
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({ timeout: 45_000 });
      const codeBox = page.locator("#si-code");
      await expect(codeBox).toHaveAttribute("autocomplete", "one-time-code");
      await expect(codeBox).toHaveAttribute("inputmode", "numeric");
      await assertCodeBoxes(page);
      await codeBox.fill("4829");
      expect(hits).toBe(0);
      await expect(page.locator(".si-code i")).toHaveText(["4", "8", "2", "9", "", ""]);
      await assertCodeBoxes(page);
      await shot(page, `signin_code_${width}`);

      holdVerify = true;
      try {
        await pasteCode(page, "000000");
        await expect(page.locator(".si-code i")).toHaveText(["0", "0", "0", "0", "0", "0"]);
        await expect.poll(() => hits).toBe(1);
      } finally {
        holdVerify = false;
        releaseVerify?.();
      }
      await expect(page.getByText("That code is not right. Check the newest email.")).toBeVisible();
      await expect(page.locator(".si-code i").first()).toHaveText("");

      await codeBox.evaluate((el) => {
        const input = el as HTMLInputElement;
        const set = (v: string) => {
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          desc!.set!.call(input, v);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("000000");
        set("111111");
      });
      await expect(page.getByText("That code is not right. Check the newest email.")).toBeVisible();
      expect(hits).toBe(2);
      await expect(page.locator(".si-code i").first()).toHaveText("");

      const code = await codeFor(email, since);
      await codeBox.fill(code);
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeHidden();
      expect(hits).toBe(3);
    });
  });
}

const PHONE_ROOT = "[data-phone-signin]";
const GIVE_UP = "The sign-in service is not answering. Check the internet and try again.";

/* The page clock stands still after this. fastForward is the only way
   the 3s waking card and the 90s abort can fire, so the test does not
   sit on a real ninety-second timer. */
async function pauseClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date("2026-10-11T12:00:00Z") });
  await phone(page, 390);
  /* Read the deadline in the page. A Node timestamp can already be
     behind the fake clock, and pauseAt refuses to move into the past. */
  const ahead = await page.evaluate(() => Date.now() + 2000);
  await page.clock.pauseAt(ahead);
}

/* Holds /api/auth/login/start open until release(). A real delay would
   race the sweep, and a real 90s wait is what the fake clock replaces. */
async function holdLogin(page: Page): Promise<() => Promise<void>> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending: Promise<void>[] = [];
  await page.route("**/api/auth/login/start", (route: Route) => {
    const job = (async () => {
      await gate;
      await route.abort().catch(() => {});
    })();
    pending.push(job);
    return job;
  });
  return async () => {
    release();
    await Promise.all(pending);
    await page.unroute("**/api/auth/login/start").catch(() => {});
  };
}

test("phone sweep of sign-in and a wrong password", async ({ page }) => {
  await phone(page, 390);
  const paint = await page.locator(PHONE_ROOT).evaluate((el) => {
    const link = el.querySelector(".si-link");
    return {
      font: getComputedStyle(el).fontFamily,
      bg: getComputedStyle(el).backgroundColor,
      link: link ? getComputedStyle(link).color : "",
    };
  });
  expect(paint.font.toLowerCase()).toContain("inter");
  expect(paint.bg).toBe("rgb(247, 246, 243)");
  expect(paint.link).toBe("rgb(31, 107, 71)");
  /* Inter is the phone face. The media attribute keeps that file off the 1280 desk. */
  const inter = await page.locator("link[rel='stylesheet'][href*='family=Inter']");
  await expect(inter).toHaveCount(1);
  await expect(inter).toHaveAttribute("media", "(max-width: 430px)");
  await phoneSweep(page, { roots: [PHONE_ROOT] });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#si-id").fill("asingh");
  await page.locator("#si-pw").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That password does not match this staff ID. Check caps lock and try again.")).toBeVisible();
  await phoneSweep(page, { roots: [PHONE_ROOT] });
});

test("phone sweep of the waking card", async ({ page }) => {
  await pauseClock(page);
  const done = await holdLogin(page);
  try {
    await page.locator("#si-id").fill("a.singh");
    await page.locator("#si-pw").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await page.clock.fastForward(3000);
    await expect(page.getByText("can take up to a minute")).toBeVisible();
    await phoneSweep(page, { roots: [PHONE_ROOT] });
    await expect(page.getByText("can take up to a minute")).toBeVisible();
  } finally {
    await done();
  }
});

test("phone sweep of the code step", async ({ page }) => {
  await phone(page, 390);
  const email = `teller-sweep-${Date.now()}@yorkfx.example`;
  const password = "counter-pass-2026";
  const made = await page.evaluate(async ({ email, password }) => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!login.ok) return { ok: false, status: login.status, step: "login" };
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: email, name: "Floor Teller", role: "teller", password }),
    });
    return { ok: res.ok, status: res.status };
  }, { email, password });
  expect(made.ok, JSON.stringify(made)).toBeTruthy();

  await page.context().clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await page.locator("#si-id").fill(email);
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
  /* "2:00" matches the sweep's clock-time rule. It is the server's
     two-minute wait before another code, counted down on this screen. */
  await phoneSweep(page, {
    roots: [PHONE_ROOT],
    exceptions: [
      { rule: "time", text: "New code", reason: "Two-minute resend cooldown from the server, not a time of day." },
    ],
  });
});

test("gives up after 90 seconds when sign-in stays quiet", async ({ page }) => {
  await pauseClock(page);
  const done = await holdLogin(page);
  try {
    await page.locator("#si-id").fill("a.singh");
    await page.locator("#si-pw").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await expect(page.getByText("can take up to a minute")).toHaveCount(0);

    await page.clock.fastForward(2_999);
    await expect(page.getByText("can take up to a minute")).toHaveCount(0);
    await page.clock.fastForward(1);
    await expect(page.getByText("can take up to a minute")).toBeVisible();
    await expect(page.getByText(GIVE_UP)).toHaveCount(0);

    await page.clock.fastForward(86_999);
    await expect(page.getByText("can take up to a minute")).toBeVisible();
    await expect(page.getByText(GIVE_UP)).toHaveCount(0);
    await page.clock.fastForward(1);

    await expect(page.getByText(GIVE_UP)).toBeVisible();
    await expect(page.getByText("can take up to a minute")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
    await expect(page.locator("#si-id")).toHaveValue("a.singh");
    await expect(page.locator("#si-pw")).toHaveValue("not-the-password");
  } finally {
    await done();
  }
});
