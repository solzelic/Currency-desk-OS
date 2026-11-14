/* ============================================================
   Early Access v2.1: the sounds land with the picture, in Safari too.

   Sol, 14 Nov, on staging in Safari: "the audio wasn't synced and there's
   a delay". Measured in WebKit (Safari's engine) and Chromium:

   - every sound was fired from a main-thread timer and scheduled 5 ms
     ahead, with nothing allowed for the time the audio takes to reach the
     ear (the output latency the browser reports, and much more on
     Bluetooth), so every cue was heard after its beat;
   - WebKit stalls for 110 to 130 ms early in the reveal, and a timer that
     lands in a stall fires late, so its sound does too, while the CSS
     animation it belongs to keeps going;
   - "Claim my desk" pressed within 260 ms of the last answer left that
     answer's chime to sound inside the logo moment.

   These record every sound the page schedules (when it asks, for which
   audio-clock time, and the latency the browser reports) and check when
   each would be heard, against the logo's own CSS animation.
   ============================================================ */
import { test, expect, type Page } from "@playwright/test";

const unique = () => Math.random().toString(36).slice(2, 8);

type Start = { perf: number; when: number; ctxNow: number; lat: number; hz: number | null };
type Log = { starts: Start[]; disc: number[]; t0: number | null; claim: number | null; suspendedAt: number | null; resumedAt: number | null };

/* In the page, before it loads: keep the context, and log every scheduled sound. */
function instrument() {
  const W = window as unknown as { __aud: Log; __ac?: AudioContext; webkitAudioContext?: typeof AudioContext };
  W.__aud = { starts: [], disc: [], t0: null, claim: null, suspendedAt: null, resumedAt: null };
  const AC = window.AudioContext || W.webkitAudioContext;
  if (AC) {
    const Kept = class extends AC { constructor(o?: AudioContextOptions) { super(o); W.__ac = this; } };
    window.AudioContext = Kept as typeof AudioContext;
    if (W.webkitAudioContext) W.webkitAudioContext = Kept as typeof AudioContext;
  }
  /* an oscillator's note is the first value its frequency is set to */
  const firstValue = new WeakMap<AudioParam, number>();
  const set = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function (v: number, t: number) {
    if (!firstValue.has(this)) firstValue.set(this, v);
    return set.call(this, v, t);
  };
  const start = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (when?: number, ...rest: number[]) {
    const ac = this.context as AudioContext;
    const freq = (this as unknown as { frequency?: AudioParam }).frequency;
    W.__aud.starts.push({
      perf: performance.now(), when: when || 0, ctxNow: ac.currentTime,
      lat: (ac.baseLatency || 0) + (ac.outputLatency || 0),
      hz: freq ? firstValue.get(freq) ?? null : null,
    });
    return (start as (w?: number, ...r: number[]) => void).call(this, when, ...rest);
  };
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...a: unknown[]) {
    W.__aud.disc.push(performance.now());
    return (disconnect as (...x: unknown[]) => void).apply(this, a);
  };
}

/* When a scheduled sound reaches the ear, on the page's performance clock. */
const heard = (s: Start) => s.perf + (Math.max(s.when, s.ctxNow) - s.ctxNow) * 1000 + s.lat * 1000;

async function toStepFour(page: Page) {
  await page.addInitScript(instrument);
  await page.goto("/early-access");
  await page.getByPlaceholder("you@yourexchange.com").pressSequentially(`snd-${unique()}@example.com`);
  await page.getByPlaceholder("you@yourexchange.com").press("Enter");
  const shop = `Sound Exchange ${unique()}`;
  await page.locator("#cd-shop").fill(shop);
  await expect(page.getByText(`${shop.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.currencydeskos.com is available`)).toBeVisible();
  await page.getByRole("button", { name: /Reserve it/ }).click();
  const sec = (n: number) => page.locator(`[data-sec="${n}"]`);
  await sec(4).getByRole("button", { name: "ON", exact: true }).click();
  await expect(sec(0).getByText(/A ballpark/)).toBeVisible();
  await sec(0).getByRole("button", { name: "$2M to $10M" }).click();
  await sec(0).getByRole("button", { name: "Just one" }).click();
  await expect(sec(5).getByText("Your MSB registration")).toBeVisible();
  await sec(5).getByRole("button", { name: "Registered", exact: true }).click();
  await sec(5).getByRole("button", { name: /^Next/ }).click();
  await expect(sec(2).getByText("No wrong answer")).toBeVisible();
  await sec(2).getByRole("button", { name: "This quarter" }).click();
  await expect(sec(1).getByText("Pick all that apply")).toBeVisible();
  await sec(1).getByRole("button", { name: /Spreadsheets/ }).click();
  await sec(1).getByRole("button", { name: /^Next/ }).click();
  await expect(sec(3).getByText("If you have one, add the address")).toBeVisible();
  await sec(3).getByRole("button", { name: "Not yet" }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await expect(page.getByText("Step 4 of 4")).toBeVisible();
  const who = (n: number) => page.locator(`[data-who="${n}"]`);
  await page.getByPlaceholder("First name").fill("Daniel");
  await page.getByPlaceholder("Last name").fill("Okafor");
  await who(0).getByRole("button", { name: /^Next/ }).click();
  await who(1).getByRole("button", { name: "Owner" }).click();
  await who(2).getByRole("button", { name: "2 to 5" }).click();
  await page.getByPlaceholder("416 555 0148").fill("416 555 0148");
}

/* On the "Claim my desk" press: note the moment, run `extra` timers from it, and read the logo
   animation's start time once it has one. */
async function onClaim(page: Page, extra: string) {
  await page.evaluate((code) => {
    const W = window as unknown as { __aud: Log; __ac?: AudioContext };
    document.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest && (e.target as HTMLElement).closest("button");
      if (!b || !/Claim my desk/.test(b.textContent || "") || W.__aud.claim !== null) return;
      W.__aud.claim = performance.now();
      setTimeout(() => {
        const a = document.getAnimations().find((x) => (x as CSSAnimation).animationName === "cdDotIris");
        W.__aud.t0 = a && typeof a.startTime === "number" ? a.startTime : null;
      }, 250);
      new Function("W", code)(W);
    }, true);
  }, extra);
}

const read = (page: Page) => page.evaluate(() => (window as unknown as { __aud: Log }).__aud);

test.describe("Early Access v2.1 sounds", () => {
  test("the logo's three beats are heard on its animation's beats, even when the page stalls", async ({ page }) => {
    await toStepFour(page);
    await page.locator('[data-who="3"]').getByRole("button", { name: /^Next/ }).click();
    await page.waitForTimeout(600); /* the last answer's own chime is over */
    /* the main thread is busy for 130 ms just before the bloom and just before the lock */
    await onClaim(page, `
      const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };
      setTimeout(() => busy(130), 390);
      setTimeout(() => busy(130), 1300);`);
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    await page.waitForTimeout(3600);
    const log = await read(page);
    expect(log.t0, "the logo animation started").not.toBeNull();
    for (const [beat, at] of [["bloom", 500], ["lock", 1410], ["settle", 2810]] as const) {
      const target = log.t0! + at;
      const near = log.starts.map(heard).filter((h) => Math.abs(h - target) < 200).sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
      expect(near.length, `${beat} was played`).toBeGreaterThan(0);
      expect(Math.abs(near[0]! - target), `${beat} heard ${Math.round(near[0]! - target)} ms off its beat`).toBeLessThanOrEqual(10);
    }
  });

  test("a sound already placed ahead is called off when the context pauses, so it never plays late", async ({ page }) => {
    await toStepFour(page);
    await page.locator('[data-who="3"]').getByRole("button", { name: /^Next/ }).click();
    await page.waitForTimeout(600);
    /* paused after the lock is placed on the audio clock and before it is heard, resumed after the settle */
    await onClaim(page, `
      setTimeout(() => { W.__aud.suspendedAt = performance.now(); W.__ac.suspend(); }, 1250);
      setTimeout(() => { W.__aud.resumedAt = performance.now(); W.__ac.resume(); }, 3200);`);
    await page.getByRole("button", { name: /Claim my desk/ }).click();
    await page.waitForTimeout(4200);
    const log = await read(page);
    expect(log.suspendedAt).not.toBeNull();
    /* the lock (heard at t0 + 1410) was placed before the pause, so it must have been called off */
    const lockPlaced = log.starts.some((s) => s.perf < log.suspendedAt! && heard(s) > log.suspendedAt!);
    expect(lockPlaced, "the lock was placed on the audio clock ahead of its beat").toBe(true);
    expect(log.disc.filter((t) => t >= log.suspendedAt!).length, "placed sounds were disconnected when the context paused").toBeGreaterThan(0);
    /* and nothing was placed while it was paused */
    expect(log.starts.filter((s) => s.perf > log.suspendedAt! + 20 && s.perf < log.resumedAt!)).toHaveLength(0);
  });

  test("Claim pressed straight after the last answer plays no stray chime inside the logo moment", async ({ page }) => {
    await toStepFour(page);
    await onClaim(page, "");
    await page.locator('[data-who="3"]').getByRole("button", { name: /^Next/ }).click();
    await page.getByRole("button", { name: /Claim my desk/ }).click(); /* well inside the 260 ms the answer's chime waits */
    await page.waitForTimeout(1500);
    const log = await read(page);
    /* 1318.5 Hz is the top note of the "done" chime: once, from the press itself */
    const done = log.starts.filter((s) => s.hz === 1318.5 && s.perf >= log.claim! - 300);
    expect(done).toHaveLength(1);
  });
});
