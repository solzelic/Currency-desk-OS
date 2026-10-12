/* The six shared phone widgets. Contrast in both themes, the toast
   band, the live region, the keypad, and the sheet focus trap. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const PHONE = { width: 390, height: 844 };

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
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
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function clearWidgets(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    document.documentElement.setAttribute("data-cdtheme", "light");
    if (w.__widgetRoot) w.__widgetRoot.render(null);
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(PHONE);
  await atDesk(page);
});

test.afterEach(async ({ page }) => {
  await clearWidgets(page);
});

test("rows, profile, and the toggle draw the six controls", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    host.style.cssText = "position:fixed; z-index:900; left:0; top:0; right:0;";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    w.__rowHit = "";
    root.render(React.createElement(React.Fragment, null,
      React.createElement(CDOS.ProfileRow, {
        initials: "AS",
        name: "Asha Singh",
        detail: "Cashier",
        onClick: () => { w.__rowHit = "profile"; },
      }),
      React.createElement(CDOS.NavRow, {
        icon: "lock",
        title: "Set/Change my PIN",
        detail: "Four digits",
        onClick: () => { w.__rowHit = "pin"; },
        rowId: "pin",
      }),
      React.createElement(CDOS.NavRow, {
        icon: "shield",
        title: "Ask before a void",
        switchOn: true,
        switchLabel: "Ask before a void",
        onClick: () => { w.__rowHit = "switch"; },
        rowId: "void",
      }),
      React.createElement(CDOS.NavRow, {
        icon: "alert",
        title: "Review",
        value: "Due",
        valueTone: "warn",
        rowId: "review",
      }),
      React.createElement(CDOS.NavRow, {
        icon: "check",
        title: "Screening",
        badge: "On",
        badgeTone: "pos",
        onClick: () => { w.__rowHit = "badge"; },
        rowId: "screen",
      }),
      React.createElement(CDOS.NavRow, {
        icon: "logout",
        title: "Sign out",
        danger: true,
        onClick: () => { w.__rowHit = "danger"; },
        rowId: "out",
      }),
      React.createElement(CDOS.Toggle, { on: false }),
    ));
  });

  const profile = page.locator("[data-phone-row='profile']");
  await expect(profile).toHaveText(/Asha Singh/);
  await expect(profile).toHaveText(/Cashier/);
  await expect(profile.locator(".av")).toHaveText("AS");
  const profileBox = await profile.boundingBox();
  expect(profileBox!.height).toBeGreaterThanOrEqual(76);
  await profile.click();
  expect(await page.evaluate(() => (window as any).__rowHit)).toBe("profile");

  const pin = page.locator("[data-phone-row='pin']");
  await expect(pin).toHaveRole("button");
  await expect(pin).toContainText("Set/Change my PIN");
  await expect(pin).toContainText("Four digits");
  const pinBox = await pin.boundingBox();
  expect(pinBox!.height).toBeGreaterThanOrEqual(56);
  await pin.click();
  expect(await page.evaluate(() => (window as any).__rowHit)).toBe("pin");

  const switched = page.locator("[data-phone-row='void']");
  await expect(switched).toHaveAttribute("role", "switch");
  await expect(switched).toHaveAttribute("aria-checked", "true");
  await expect(switched.locator(".switch")).toHaveClass(/on/);
  await expect(switched.locator(".switch")).toHaveAttribute("aria-hidden", "true");

  const review = page.locator("[data-phone-row='review']");
  await expect(review).toContainText("Due");
  expect(await review.evaluate((el) => el.tagName)).toBe("DIV");

  await expect(page.locator("[data-phone-row='screen'] .badge")).toHaveText("On");
  const danger = page.locator("[data-phone-row='out']");
  await expect(danger.locator(".cv")).toHaveCount(0);

  const off = page.locator("#widget-probe > .switch");
  await expect(off).toHaveAttribute("aria-hidden", "true");
  await expect(off).not.toHaveClass(/\bon\b/);
  expect(await off.evaluate((el) => el.tagName)).toBe("SPAN");
});

test("every widget text pair is at least 4.5 to 1 in both themes", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const { React, ReactDOM, CDOS } = w;
    let host = document.getElementById("widget-probe");
    if (!host) {
      host = document.createElement("div");
      host.id = "widget-probe";
      document.body.appendChild(host);
    }
    const root = w.__widgetRoot || ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    root.render(React.createElement(React.Fragment, null,
      React.createElement(CDOS.ProfileRow, { initials: "AS", name: "Asha Singh", detail: "Cashier", onClick: () => {} }),
      React.createElement(CDOS.NavRow, { icon: "lock", title: "Set/Change my PIN", detail: "Four digits", onClick: () => {}, rowId: "pin" }),
      React.createElement(CDOS.NavRow, { icon: "shield", title: "Ask before a void", switchOn: false, onClick: () => {}, rowId: "void" }),
      React.createElement(CDOS.NavRow, { icon: "alert", title: "Review", value: "Due", valueTone: "warn", rowId: "review" }),
      React.createElement(CDOS.NavRow, { icon: "check", title: "Screening", badge: "On", badgeTone: "pos", onClick: () => {}, rowId: "screen" }),
      React.createElement(CDOS.NavRow, { icon: "logout", title: "Sign out", danger: true, onClick: () => {}, rowId: "out" }),
      React.createElement(CDOS.FullScreenSheet, { title: "PIN", onClose: () => {} },
        React.createElement("p", { className: "phone-banner info" }, "Keep this PIN to yourself"),
        React.createElement(CDOS.PinPad, {
          step: 1,
          steps: 2,
          question: "Choose a PIN",
          hint: "Four digits",
          digits: "12",
          error: "Those digits do not match",
          forgotLabel: "Forgot PIN",
          onForgot: () => {},
          onDigit: () => {},
          onDelete: () => {},
        }),
      ),
      React.createElement(CDOS.Toast, { text: "PIN saved", actionLabel: "Undo", onAction: () => {} }),
    ));
  });

  const failures = await page.evaluate(() => {
    function parseColor(value: string) {
      const m = String(value || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
      if (!m) return null;
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] == null ? 1 : Number(m[4]) };
    }
    function blend(fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) {
      const a = fg.a;
      return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
    }
    function backdrop(el: Element) {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      let node: Element | null = el;
      while (node) {
        const bg = parseColor(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        if (bg && bg.a >= 0.99) break;
        node = node.parentElement;
      }
      let out = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = layers.length - 1; i >= 0; i--) out = blend(layers[i], out);
      return out;
    }
    function lum(c: { r: number; g: number; b: number }) {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    }
    function ratio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    function shown(el: Element) {
      let node: Element | null = el;
      while (node) {
        const st = getComputedStyle(node);
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
        node = node.parentElement;
      }
      const box = el.getBoundingClientRect();
      return box.width >= 1 && box.height >= 1;
    }
    function directText(el: Element) {
      let s = "";
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) s += node.textContent || "";
      }
      return s.replace(/\s+/g, " ").trim();
    }
    function collect(theme: string) {
      document.documentElement.setAttribute("data-cdtheme", theme);
      const roots = Array.from(document.querySelectorAll("#widget-probe, .sheet, .phone-toast"));
      const lines: string[] = [];
      const seen = new Set<Element>();
      for (const root of roots) {
        const nodes: Element[] = [root];
        root.querySelectorAll("*").forEach((el) => nodes.push(el));
        for (const el of nodes) {
          if (seen.has(el) || !shown(el)) continue;
          seen.add(el);
          const text = directText(el);
          if (!text) continue;
          const style = getComputedStyle(el);
          const px = parseFloat(style.fontSize);
          const weight = style.fontWeight === "bold" ? 700 : (parseInt(style.fontWeight, 10) || 400);
          const large = px >= 24 || (px >= 18.66 && weight >= 700);
          const fg = parseColor(style.color);
          if (!fg || fg.a <= 0.05) continue;
          const bg = backdrop(el);
          const ink = blend(fg, bg);
          const value = ratio(ink, bg);
          const need = large ? 3 : 4.5;
          if (value + 0.02 < need) {
            lines.push(theme + " " + value.toFixed(2) + ":1 needs " + need + ":1 \"" + text.slice(0, 40) + "\"");
          }
        }
      }
      return lines;
    }
    return collect("light").concat(collect("dark"));
  });
  expect(failures).toEqual([]);
});

test("the keypad takes a hardware key and a paste and says N of 4 digits", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    host.style.cssText = "position:fixed; z-index:900; left:0; top:0; right:0;";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    function Pad() {
      const [digits, setDigits] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      w.__setBusy = setBusy;
      return React.createElement(CDOS.PinPad, {
        step: 1,
        steps: 2,
        question: "Choose a PIN",
        digits,
        busy,
        onDigit: (d: string) => setDigits((cur: string) => (cur + d).slice(0, 4)),
        onDelete: () => setDigits((cur: string) => cur.slice(0, -1)),
      });
    }
    root.render(React.createElement(Pad));
  });

  const count = page.locator(".pin-count");
  await expect(count).toHaveText("0 of 4 digits");
  await page.keyboard.press("1");
  await expect(count).toHaveText("1 of 4 digits");
  await page.keyboard.press("2");
  await expect(count).toHaveText("2 of 4 digits");
  await page.keyboard.press("Backspace");
  await expect(count).toHaveText("1 of 4 digits");
  await page.keyboard.press("Delete");
  await expect(count).toHaveText("0 of 4 digits");

  const pasted = await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "12-34");
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(pasted).toBe(true);
  await expect(count).toHaveText("4 of 4 digits");

  await page.evaluate(() => (window as any).__setBusy(true));
  await expect(page.locator(".pin-saving")).toHaveText("Saving...");
  await page.keyboard.press("5");
  await expect(page.locator(".pin-saving")).toHaveText("Saving...");
  await expect(page.locator(".keypad button", { hasText: "5" })).toBeDisabled();
});

test("the sheet traps focus and Escape returns it to the opener", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    host.style.cssText = "position:fixed; z-index:900; left:0; top:0; right:0;";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    function Scene() {
      const [open, setOpen] = React.useState(false);
      return React.createElement(React.Fragment, null,
        React.createElement("button", { id: "open-pin", type: "button", onClick: () => setOpen(true) }, "Set/Change my PIN"),
        open ? React.createElement(CDOS.FullScreenSheet, { title: "PIN", onClose: () => setOpen(false) },
          React.createElement("button", { id: "sheet-mid", type: "button" }, "Middle"),
          React.createElement("button", { id: "sheet-last", type: "button" }, "Done"),
        ) : null,
      );
    }
    root.render(React.createElement(Scene));
  });

  const opener = page.locator("#open-pin");
  await opener.click();
  const sheet = page.locator(".sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".phone-sheet-x")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#sheet-mid")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#sheet-last")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".phone-sheet-x")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#sheet-last")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("the toast does not cover the PIN control or keys 7 8 and 9", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    host.style.cssText = "position:fixed; z-index:900; left:0; top:0; right:0;";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    document.querySelectorAll(".phone-sticky").forEach((el) => {
      (el as HTMLElement).style.setProperty("display", "none", "important");
    });
    const buttonStyle = {
      position: "fixed",
      left: "16px",
      width: "220px",
      height: "48px",
      bottom: "80px",
      zIndex: 700,
    };
    root.render(React.createElement(React.Fragment, null,
      React.createElement("button", { id: "set-pin", type: "button", style: buttonStyle }, "Set/Change my PIN"),
      React.createElement(CDOS.FullScreenSheet, { title: "PIN", onClose: () => {} },
        React.createElement(CDOS.PinPad, {
          step: 1,
          steps: 2,
          question: "Choose a PIN",
          hint: "Four digits you can change later",
          digits: "",
          onDigit: () => {},
          onDelete: () => {},
        }),
      ),
      React.createElement(CDOS.Toast, { text: "PIN saved", actionLabel: "Undo", onAction: () => {} }),
    ));
  });

  function overlaps(a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null) {
    if (!a || !b) return false;
    return a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
  }

  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    const toast = page.locator(".phone-toast");
    await expect(toast).toBeVisible();
    const toastBox = await toast.boundingBox();
    const pinBox = await page.locator("#set-pin").boundingBox();
    expect(overlaps(toastBox, pinBox), width + " PIN").toBe(false);
    const questionBox = await page.locator(".pin-q").boundingBox();
    const hintBox = await page.locator(".pin-s").boundingBox();
    const dotsBox = await page.locator(".pin-dots").boundingBox();
    expect(overlaps(toastBox, questionBox), width + " question").toBe(false);
    expect(overlaps(toastBox, hintBox), width + " hint").toBe(false);
    expect(overlaps(toastBox, dotsBox), width + " dots").toBe(false);
    for (const key of ["7", "8", "9"]) {
      const keyBox = await page.locator(".keypad").getByRole("button", { name: key, exact: true }).boundingBox();
      expect(overlaps(toastBox, keyBox), width + " key " + key).toBe(false);
    }
    const passed = await page.locator("#set-pin").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!(hit && (hit === el || el.contains(hit)));
    });
    expect(passed, width + " tap").toBe(true);
  }

  const events = await page.locator(".phone-toast").evaluate((el) => {
    const action = el.querySelector(".phone-toast-go");
    return {
      line: getComputedStyle(el).pointerEvents,
      action: action ? getComputedStyle(action).pointerEvents : "",
    };
  });
  expect(events.line).toBe("none");
  expect(events.action).toBe("auto");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".phone-toast")).toBeHidden();
  await expect(page.locator(".sheet")).toBeHidden();
  const desktopHit = await page.locator("#set-pin").evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!(hit && (hit === el || el.contains(hit)));
  });
  expect(desktopHit).toBe(true);
});

test("the toast announces after mount and stays while its action is focused", async ({ page }) => {
  const atInsert = await page.evaluate(() => new Promise((resolve) => {
    const w = window as any;
    w.__liveAtInsert = "missing";
    const proto = Node.prototype;
    const origAppend = proto.appendChild;
    const origInsert = proto.insertBefore;
    const snap = (node: Node) => {
      if (!(node instanceof HTMLElement) || w.__liveAtInsert !== "missing") return;
      const live = node.classList.contains("phone-toast-live")
        ? node
        : node.querySelector(".phone-toast-live");
      if (live) w.__liveAtInsert = live.textContent ?? "";
    };
    proto.appendChild = function (this: Node, node: Node) {
      snap(node);
      return origAppend.call(this, node);
    };
    proto.insertBefore = function (this: Node, node: Node, child: Node | null) {
      snap(node);
      return origInsert.call(this, node, child);
    };
    const restore = () => {
      proto.appendChild = origAppend;
      proto.insertBefore = origInsert;
    };
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    host.style.cssText = "position:fixed; z-index:900; left:0; top:0; right:0;";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    w.__toastDone = false;
    root.render(React.createElement(CDOS.Toast, {
      text: "PIN saved",
      actionLabel: "Undo",
      onAction: () => {},
      onDone: () => {
        w.__toastDone = true;
        root.render(React.createElement(CDOS.Toast, { text: "" }));
      },
    }));
    const wait = () => {
      if (document.querySelector(".phone-toast-live")) {
        restore();
        resolve(w.__liveAtInsert);
        return;
      }
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  }));
  expect(atInsert).toBe("");
  await expect(page.locator(".phone-toast-live")).toHaveText("PIN saved");
  await expect(page.locator(".phone-toast")).toContainText("PIN saved");

  await page.clock.install();
  await page.evaluate(() => {
    const w = window as any;
    w.__toastDone = false;
    w.__widgetRoot.render(null);
  });
  await page.evaluate(() => {
    const w = window as any;
    w.__widgetRoot.render(w.React.createElement(w.CDOS.Toast, {
      text: "Still here",
      actionLabel: "Undo",
      onAction: () => {},
      onDone: () => {
        w.__toastDone = true;
        w.__widgetRoot.render(w.React.createElement(w.CDOS.Toast, { text: "" }));
      },
    }));
  });
  await expect(page.locator(".phone-toast")).toContainText("Still here");
  await page.locator(".phone-toast-go").focus();
  await page.clock.fastForward(4500);
  await expect(page.locator(".phone-toast")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__toastDone)).toBe(false);

  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.blur) active.blur();
  });
  await page.clock.fastForward(4500);
  expect(await page.evaluate(() => (window as any).__toastDone)).toBe(true);
  await expect(page.locator(".phone-toast")).toBeHidden();
});

test("the toast stays up for 4 seconds", async ({ page }) => {
  /* Paused, so a jump of 3999ms cannot run past the 4000ms timer
     while the assertion is in flight. */
  await page.clock.pauseAt(new Date("2026-06-18T15:02:00Z"));
  await page.evaluate(() => {
    const w = window as any;
    w.__toastDone = false;
    w.__toastDelay = 0;
    const fake = window.setTimeout.bind(window);
    window.setTimeout = (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const delay = typeof ms === "number" ? ms : 0;
      if (delay >= 100) w.__toastDelay = delay;
      return fake(fn, ms as number, ...args);
    };
    const { React, ReactDOM, CDOS } = w;
    const host = document.createElement("div");
    host.id = "widget-probe";
    document.body.appendChild(host);
    const root = ReactDOM.createRoot(host);
    w.__widgetRoot = root;
    root.render(React.createElement(CDOS.Toast, {
      text: "PIN saved",
      onDone: () => {
        w.__toastDone = true;
        root.render(React.createElement(CDOS.Toast, { text: "" }));
      },
    }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__toastDelay), { timeout: 3_000 }).toBeGreaterThanOrEqual(4000);
  await expect(page.locator(".phone-toast")).toBeVisible();
  await page.clock.runFor(3999);
  await expect(page.locator(".phone-toast")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__toastDone)).toBe(false);
  await page.clock.runFor(1);
  expect(await page.evaluate(() => (window as any).__toastDone)).toBe(true);
  await expect(page.locator(".phone-toast")).toBeHidden();
});
