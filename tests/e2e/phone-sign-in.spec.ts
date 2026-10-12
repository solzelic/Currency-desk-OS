/* Phone shop sign-in. Under 430px the desk asks for the staff ID and
   the password on one screen, then the emailed code. A wide window
   keeps the screen it already had.

   The password is never written to storage. The staff ID is. The code
   is sent once when the sixth digit lands, even if the field reports
   that value twice. Pasting six digits fills every box and sends once. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Page, Route } from "@playwright/test";
import { test, expect, codeFor, logSize } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

/* A temp directory, not a fixed artifact path. The run that writes
   the pictures and the run that links them have to agree, and a
   missing file must not be a link to a box that was never filled. */
const SHOTS = path.join(tmpdir(), "currencydesk-phone-signin");
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/* 6×44 + 5×8 = 304. Centered, that row fits a 360px phone with the
   16px gutter, and neither end box may sit outside the viewport. */
async function assertCodeBoxes(page: Page): Promise<void> {
  /* A click in a text field is :focus-visible. The active box's ring
     is that selector, so the measure has to happen while it matches. */
  await page.locator("#si-code").click();
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
  await shot(page, "signin_desktop_1280");
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
      await expect(page.locator(".si-err")).toHaveCSS("font-size", "14px");
      await expect(page.locator("#si-id")).toHaveValue("asingh");
      await expect(page.locator("#si-pw")).toHaveValue("");
      await expect(page.locator("#si-pw")).toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem("phone_staff_id"))).toBeNull();
      await shot(page, `signin_error_${width}`);
      if (width === 390) {
        await page.setViewportSize({ width: 430, height: 844 });
        await shot(page, "signin_error_430");
        await page.setViewportSize({ width: 390, height: 844 });
      }

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
      if (width === 390) {
        await page.setViewportSize({ width: 430, height: 844 });
        await shot(page, "signin_waking_430");
        await page.setViewportSize({ width: 390, height: 844 });
      }
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

/* The countdown is one timeout per second, and the next one is armed
   only after React commits. clock.fastForward fires the timers that
   already exist and then jumps, so a two-minute wait would shrink by
   a single second. runFor walks them one second at a time. */
async function tickUntil(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name });
  for (let i = 0; i < 150; i++) {
    if (await button.isVisible().catch(() => false)) return;
    await page.clock.runFor(1000);
  }
  await expect(button).toBeVisible();
}

const CODE_WRONG = "That code is not right. Check the newest email.";
const CODE_EXPIRED = "That code has expired. Sign in again for a new one.";
const CODE_LOCKED = "This sign-in is locked after 5 tries.";
const SIGNIN_TROUBLE = "Sign-in is having trouble. Try again in a minute.";
const PASTE_ONLY = "Paste only the 6-digit code.";
const RESEND_SENT = "A new code is on its way.";

async function storedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || "";
      parts.push(k + "=" + (localStorage.getItem(k) || ""));
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) || "";
      parts.push(k + "=" + (sessionStorage.getItem(k) || ""));
    }
    return parts.join("\n");
  });
}

/* A teller with an email, so the password is not enough on its own.
   The owner session that creates them is cleared before the phone
   signs in as the teller. */
async function makeTeller(page: Page, label: string): Promise<{ email: string; password: string }> {
  const email = `teller-${label}-${Date.now()}@yorkfx.example`;
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
  await page.evaluate(() => sessionStorage.clear());
  return { email, password };
}

async function reachCode(page: Page, email: string, password: string): Promise<void> {
  await page.reload();
  await expect(page.locator("#si-id")).toBeVisible();
  await page.locator("#si-id").fill(email);
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
}

test("back, refresh, browser back, and another account return to the code step", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "return");
  await reachCode(page, email, password);
  const raw = await page.evaluate(() => sessionStorage.getItem("phone_signin_step"));
  expect(raw, "the step is kept").toBeTruthy();
  const saved = JSON.parse(raw || "{}") as { step?: string; password?: string; code?: string };
  expect(saved.step).toBe("code");
  expect(saved.password, "password kept").toBeUndefined();
  expect(saved.code, "code kept").toBeUndefined();
  expect(await storedText(page), "password kept").not.toContain(password);

  await page.reload();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
  await expect(page.getByText("A code went out moments ago")).toHaveCount(0);
  expect(await storedText(page), "password kept after refresh").not.toContain(password);

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#si-id")).toHaveValue(email);
  await expect(page.locator("#si-pw")).toHaveValue("");
  await page.goBack();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
  expect(await storedText(page), "password kept after browser back").not.toContain(password);

  await page.getByRole("button", { name: "Back" }).click();
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
  await expect(page.getByText("A code went out moments ago")).toHaveCount(0);

  await page.getByRole("button", { name: "Use another account" }).click();
  await expect(page.locator("#si-id")).toHaveValue("");
  await expect(page.locator("#si-pw")).toHaveValue("");
  await page.goBack();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await page.getByRole("button", { name: "Use another account" }).click();
  await page.locator("#si-id").fill(email);
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
  await expect(page.getByText("A code went out moments ago")).toHaveCount(0);
  expect(await storedText(page), "password kept after another account").not.toContain(password);
});

test("a code already sent opens the boxes with the remaining wait", async ({ page }) => {
  await phone(page, 360);
  await page.route("**/api/auth/login/start", (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({
      error: "too_soon",
      detail: "A code went out moments ago. You can ask for another in 45 seconds.",
      retryAfter: 45,
    }),
  }));
  await page.locator("#si-id").fill("someone@yorkfx.example");
  await page.locator("#si-pw").fill("counter-pass-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in 0:4\d/)).toBeVisible();
  await expect(page.getByText("A code went out moments ago")).toHaveCount(0);
  expect(await storedText(page), "password kept").not.toContain("counter-pass-2026");
  await shot(page, "signin_already_360");
});

test("resize and landscape keep the phone code step", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "resize");
  await reachCode(page, email, password);
  const sizes = [
    { width: 360, height: 640 },
    { width: 430, height: 800 },
    { width: 780, height: 360 },
    { width: 844, height: 390 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.locator("[data-phone-signin]"), `${size.width}x${size.height}`).toHaveCount(1);
    await expect(page.locator(".si-code i")).toHaveCount(6);
    await expect(page.getByText("CURRENCYDESK ID")).toHaveCount(0);
    await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();
    if (size.width === 430) await shot(page, "signin_code_430");
  }
  /* Crossing to the desk has to run the matchMedia listener. A reload
     at 1280 would take the desktop tree from the first read, and the
     missing listener would stay green. */
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator("[data-phone-signin]"), "resize listener").toHaveCount(0);
  await expect(page.getByText("A fresh 6-digit code just went to")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-phone-signin]")).toHaveCount(1);
  await expect(page.locator(".si-code i")).toHaveCount(6);
  expect(await storedText(page), "password kept").not.toContain(password);
  await shot(page, "signin_code_landscape");

  await page.setViewportSize({ width: 780, height: 360 });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator("[data-phone-signin]")).toHaveCount(1);
  await expect(page.locator("#si-id")).toBeVisible();
  await expect(page.getByText("CURRENCYDESK ID")).toHaveCount(0);
});

for (const height of [400, 640]) {
  test(`Sign in stays 52px and on screen at 360x${height}`, async ({ page }) => {
    await phone(page, 360);
    await page.setViewportSize({ width: 360, height });
    await page.locator("#si-id").fill("a.singh");
    await page.locator("#si-pw").click();
    await page.locator("#si-pw").fill("yorkville");
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
    }));
    const box = await page.getByRole("button", { name: "Sign in" }).boundingBox();
    expect(box, "Sign in button").toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(52);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
    await shot(page, `signin_keyboard_360x${height}`);
  });
}

test("the focus ring is only on :focus-visible", async ({ page }) => {
  await phone(page, 360);
  await page.locator("#si-id").fill("a.singh");
  await page.locator("#si-pw").fill("yorkville");
  /* A thumb press focuses the control without the ring. Script focus
     matches :focus-visible in Chromium, so a click is the press.
     The eye is not Sign in: pressing Sign in would leave this screen. */
  const eye = page.locator(".si-eye");
  await eye.click();
  await expect(eye).toBeFocused();
  const pointed = await eye.evaluate((el) => ({
    visible: el.matches(":focus-visible"),
    outline: getComputedStyle(el).outlineStyle,
  }));
  expect(pointed.visible).toBe(false);
  expect(pointed.outline).toBe("none");
  await page.locator("#si-pw").focus();
  await page.keyboard.press("Tab");
  await expect(eye).toBeFocused();
  const eyeKeyed = await eye.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(eyeKeyed).not.toBe("none");
  const button = page.getByRole("button", { name: "Sign in" });
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const keyed = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(keyed).not.toBe("none");
});

test("paste keeps one 6-digit run and spends no try otherwise", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "paste");
  let hits = 0;
  let release: (() => void) | null = null;
  let hold = false;
  await page.route("**/api/auth/login/verify", async (route) => {
    hits += 1;
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  await reachCode(page, email, password);
  expect(await page.locator("#si-code").getAttribute("maxlength")).toBeNull();

  const good = [" 482913", "482 913", "Till 2: your code is 482913", "٤٨٢٩١٣", "４８２９１３"];
  for (const text of good) {
    const before = hits;
    hold = true;
    try {
      await pasteCode(page, text);
      await expect(page.locator(".si-code i")).toHaveText(["4", "8", "2", "9", "1", "3"]);
      await expect.poll(() => hits).toBe(before + 1);
    } finally {
      hold = false;
      release?.();
      release = null;
    }
    await expect(page.getByText(CODE_WRONG)).toBeVisible();
    await expect(page.locator(".si-code i").first()).toHaveText("");
  }

  for (const text of ["1234567", "12345678", "abcdef"]) {
    const before = hits;
    await pasteCode(page, text);
    await expect(page.getByText(PASTE_ONLY)).toBeVisible();
    await expect(page.locator(".si-code i").first()).toHaveText("");
    expect(hits, text).toBe(before);
  }

  /* The paste handler has to cancel the browser's own insert. Without
     preventDefault the field also takes the raw text, and this is the
     assertion that goes red when that line is removed. */
  const prevented = await page.locator("#si-code").evaluate((el) => new Promise((resolve) => {
    const done = (event: Event) => {
      window.removeEventListener("paste", done);
      resolve((event as ClipboardEvent).defaultPrevented);
    };
    window.addEventListener("paste", done);
    const data = new DataTransfer();
    data.setData("text/plain", "Till 2: your code is 482913");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    el.dispatchEvent(event);
  }));
  expect(prevented, "paste preventDefault").toBe(true);
});

test("the sixth digit is sent once when the field reports it twice", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "once");
  let hits = 0;
  let release: (() => void) | null = null;
  await page.route("**/api/auth/login/verify", async (route) => {
    hits += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  await reachCode(page, email, password);
  await page.locator("#si-code").evaluate((el) => {
    const input = el as HTMLInputElement;
    const set = (value: string) => {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      desc!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("482913");
    set("482913");
  });
  await expect.poll(() => hits, { timeout: 5_000 }).toBe(1);
  release?.();
  expect(await storedText(page), "password kept").not.toContain(password);
});

test("expired, locked, and a server failure each have their own sentence", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "answers");
  await reachCode(page, email, password);

  await page.route("**/api/auth/login/verify", (route) => route.fulfill({
    status: 410,
    contentType: "application/json",
    body: JSON.stringify({ error: "expired", detail: "That code expired — sign in again." }),
  }));
  await page.locator("#si-code").fill("123456");
  await expect(page.getByText(CODE_EXPIRED)).toBeVisible();
  await expect(page.getByText(CODE_WRONG)).toHaveCount(0);
  await expect(page.getByText(CODE_LOCKED)).toHaveCount(0);

  await page.unroute("**/api/auth/login/verify");
  await page.route("**/api/auth/login/verify", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "boom", status: 500 }),
  }));
  await page.locator("#si-code").fill("123456");
  await expect(page.locator(".si-err")).toHaveText(SIGNIN_TROUBLE);
  await expect(page.locator(".si-err")).not.toContainText("500");
  await expect(page.getByText(CODE_WRONG)).toHaveCount(0);

  await page.unroute("**/api/auth/login/verify");
  for (let i = 0; i < 5; i++) {
    await page.locator("#si-code").fill("000000");
    await expect(page.getByText(CODE_WRONG)).toBeVisible();
  }
  await page.locator("#si-code").fill("111111");
  await expect(page.getByText(CODE_LOCKED)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByText(/New code in/)).toHaveCount(0);
  await expect(page.locator(".si-err")).toHaveCSS("font-size", "14px");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 780 });
    await shot(page, `signin_lockout_${width}`);
  }
  expect(await page.evaluate(() => sessionStorage.getItem("phone_signin_step"))).toBeNull();
  await page.getByRole("button", { name: "Sign in again" }).click();
  await expect(page.locator("#si-id")).toHaveValue(email);
  await expect(page.locator(".si-code")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#si-id")).toBeVisible();
  await expect(page.getByText(CODE_LOCKED)).toHaveCount(0);
  await expect(page.locator(".si-code")).toHaveCount(0);

  /* The lock deleted the code and the send wait. Sign in again has
     to email a new one now, not open empty boxes for two minutes. */
  const since = logSize();
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const fresh = await codeFor(email, since);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText("A code went out moments ago")).toHaveCount(0);
  await page.locator("#si-code").fill(fresh);
  await expect(page.getByText(CODE_EXPIRED)).toHaveCount(0);
  await expect(page.getByText(CODE_LOCKED)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeHidden();
});

const NEED_CURRENT = "Enter the password you were given. Then you can set your own.";

test("a refresh on the code step asks for the temporary password again", async ({ page }) => {
  await phone(page, 390);
  const { email, password } = await makeTeller(page, "first");
  const since = logSize();
  await reachCode(page, email, password);
  await page.reload();
  await expect(page.locator(".si-code i")).toHaveCount(6);
  const code = await codeFor(email, since);
  await page.locator("#si-code").fill(code);
  await expect(page.getByText(NEED_CURRENT)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set your own password" })).toHaveCount(0);
  await expect(page.locator("#si-id")).toHaveValue(email);
  await expect(page.locator("#si-pw")).toHaveValue("");
  expect(await storedText(page), "password kept").not.toContain(password);

  let current = "";
  await page.route("**/api/auth/change-password", async (route) => {
    current = JSON.parse(route.request().postData() || "{}").currentPassword || "";
    await route.continue();
  });
  await page.locator("#si-pw").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
  await page.getByPlaceholder("at least 8 characters").fill("fresh-pass-2026");
  await page.getByPlaceholder("••••••••").fill("fresh-pass-2026");
  await page.getByRole("button", { name: "Save & continue" }).click();
  await expect(page.getByRole("heading", { name: "Set your own password" })).toBeHidden({ timeout: 20_000 });
  expect(current, "re-entered password").toBe(password);
  await expect(page.getByText(/400/)).toHaveCount(0);
});

test("resend checks the server answer before saying a code is on its way", async ({ page }) => {
  await pauseClock(page);
  const { email, password } = await makeTeller(page, "resend");
  await reachCode(page, email, password);
  await tickUntil(page, "Send a new code");
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByText(RESEND_SENT)).toHaveCount(0);
  await expect(page.locator(".si-code i")).toHaveCount(6);
  await expect(page.getByText(/New code in \d+:\d\d/)).toBeVisible();

  await tickUntil(page, "Send a new code");
  await page.route("**/api/auth/login/start", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "upstream" }),
  }));
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.locator(".si-err")).toHaveText(SIGNIN_TROUBLE);
  await expect(page.getByText(RESEND_SENT)).toHaveCount(0);
  await expect(page.locator(".si-err")).not.toContainText("500");

  await page.unroute("**/api/auth/login/start");
  await page.route("**/api/auth/login/start", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      needsCode: true,
      maskedEmail: "t•••@yorkfx.example",
      user: { id: email, name: "Floor Teller", role: "teller", tenantId: "tnt-yorkfx", mustChangePassword: false },
    }),
  }));
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByText(RESEND_SENT)).toBeVisible();
  await expect(page.locator(".si-code i").first()).toHaveText("");
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await shot(page, `signin_resend_${width}`);
  }
  expect(await storedText(page), "password kept").not.toContain(password);
});

test("a 500 on sign-in does not show the status", async ({ page }) => {
  await phone(page, 390);
  await page.route("**/api/auth/login/start", (route) => route.fulfill({
    status: 502,
    contentType: "text/plain",
    body: "bad gateway",
  }));
  await page.locator("#si-id").fill("a.singh");
  await page.locator("#si-pw").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".si-err")).toHaveText(SIGNIN_TROUBLE);
  await expect(page.getByText(/502/)).toHaveCount(0);
  await expect(page.locator(".si-code")).toHaveCount(0);
});

test("dark theme keeps error, link, and grey text at 4.5:1", async ({ page }) => {
  await phone(page, 390);
  await page.evaluate(() => localStorage.setItem("cdos_theme", "dark"));
  await page.reload();
  await expect(page.locator("#lock.si-phone")).toHaveCSS("background-color", "rgb(247, 246, 243)");
  await expect(page.locator("#lock.si-phone")).toHaveCSS("color-scheme", "light");
  await page.locator("#si-id").fill("asingh");
  await page.locator("#si-pw").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".si-err")).toBeVisible();
  await expect(page.locator(".si-err")).toHaveCSS("font-size", "14px");
  const rows = await page.locator("#lock.si-phone").evaluate((root) => {
    const bgOf = (el: Element) => {
      let node: Element | null = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        if (m && (m[4] == null || Number(m[4]) > 0.99)) return bg;
        node = node.parentElement;
      }
      return getComputedStyle(root).backgroundColor;
    };
    const pick = (sel: string) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, bg: bgOf(el), text: (el.textContent || "").trim().slice(0, 40) };
    };
    return { err: pick(".si-err"), link: pick(".si-link"), lead: pick(".si-lead") };
  });
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = (css: string) => {
    const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    if (!m) throw new Error(css);
    return 0.2126 * lin(Number(m[1])) + 0.7152 * lin(Number(m[2])) + 0.0722 * lin(Number(m[3]));
  };
  for (const [name, row] of Object.entries(rows)) {
    expect(row, name).toBeTruthy();
    const hi = Math.max(L(row!.color), L(row!.bg));
    const lo = Math.min(L(row!.color), L(row!.bg));
    const ratio = (hi + 0.05) / (lo + 0.05);
    expect(ratio, `${name} ${row!.color} on ${row!.bg} (${row!.text})`).toBeGreaterThanOrEqual(4.5);
  }
  await phoneSweep(page, { roots: [PHONE_ROOT] });
});
