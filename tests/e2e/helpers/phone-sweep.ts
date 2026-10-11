/* Shared phone sweep. Every phone screen PR imports this and runs it
   on that screen. The rules are documented in docs/PHONE_SHELL.md. */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export type PhoneSweepRule = "hit" | "size" | "contrast" | "time" | "date";

export type PhoneSweepException = {
  rule: PhoneSweepRule;
  /** Substring of the visible text this waives. */
  text?: string;
  /** CSS selector the element must match. */
  selector?: string;
  reason: string;
};

export type PhoneSweepOptions = {
  /** Screen roots. A window under the screen is not included. */
  roots: string[];
  exceptions?: PhoneSweepException[];
  /** Defaults to 360 and 390. */
  widths?: number[];
};

type SweepArgs = {
  roots: string[];
  exceptions: PhoneSweepException[];
};

type SweepReport = {
  failures: string[];
  used: number[];
};

function sweepInPage(args: SweepArgs): SweepReport {
  const INTERACTIVE = [
    "button",
    "a[href]",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[role='tab']",
    "[role='link']",
    "[role='checkbox']",
    "[role='switch']",
    "[role='menuitem']",
    "[role='option']",
  ].join(", ");
  const failures: string[] = [];
  const used: number[] = [];
  const exceptions = args.exceptions || [];

  function shown(el: Element): boolean {
    let node: Element | null = el;
    while (node) {
      const st = getComputedStyle(node);
      if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      node = node.parentElement;
    }
    const box = el.getBoundingClientRect();
    return box.width >= 1 && box.height >= 1;
  }

  function labelOf(el: Element): string {
    const raw = el instanceof HTMLElement
      ? (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
      : "";
    const text = raw.replace(/\s+/g, " ").trim().slice(0, 70);
    const id = el.id ? "#" + el.id : "";
    const cls = typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    return el.tagName.toLowerCase() + id + (cls ? "." + cls : "") + (text ? " \"" + text + "\"" : "");
  }

  function waived(rule: PhoneSweepRule, text: string, el: Element): boolean {
    let ok = false;
    exceptions.forEach((ex, i) => {
      if (!ex || ex.rule !== rule) return;
      if (!ex.text && !ex.selector) return;
      if (ex.text && text.indexOf(ex.text) < 0) return;
      if (ex.selector) {
        try { if (!el.matches(ex.selector)) return; } catch (e) { return; }
      }
      if (used.indexOf(i) < 0) used.push(i);
      ok = true;
    });
    return ok;
  }

  function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
    const m = String(value || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] == null ? 1 : Number(m[4]) };
  }

  function blend(
    fg: { r: number; g: number; b: number; a: number },
    bg: { r: number; g: number; b: number; a: number },
  ) {
    const a = fg.a;
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    };
  }

  function backdrop(el: Element) {
    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    /* The element's own fill is the nearest layer. An avatar's white
       initials sit on the circle, not on the header behind it. */
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

  function contrast(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
    const l1 = lum(a);
    const l2 = lum(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function directText(el: Element): string {
    let s = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) s += node.textContent || "";
    }
    return s.replace(/\s+/g, " ").trim();
  }

  function checkText(el: Element, text: string, style: CSSStyleDeclaration) {
    const px = parseFloat(style.fontSize);
    if (px + 0.05 < 12 && !waived("size", text, el)) {
      failures.push("text " + px.toFixed(1) + "px on " + labelOf(el));
    }
    const weight = style.fontWeight === "bold" ? 700 : (parseInt(style.fontWeight, 10) || 400);
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    const fg = parseColor(style.color);
    if (fg && fg.a > 0.05) {
      const bg = backdrop(el);
      const ink = blend(fg, bg);
      const ratio = contrast(ink, bg);
      const need = large ? 3 : 4.5;
      if (ratio + 0.02 < need && !waived("contrast", text, el)) {
        failures.push("contrast " + ratio.toFixed(2) + ":1 needs " + need + ":1 on " + labelOf(el));
      }
    }
    const time = /\b([01]?\d|2[0-3]):[0-5]\d\b/g;
    let m: RegExpExecArray | null;
    while ((m = time.exec(text))) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      if (/^\s*(am|pm)\b/i.test(after) || /(am|pm)\s*$/i.test(before)) continue;
      if (!waived("time", text, el)) failures.push("24-hour time \"" + m[0] + "\" on " + labelOf(el));
    }
    const date = text.match(/\d{4}-\d{2}-\d{2}/);
    if (date && !waived("date", text, el)) failures.push("ISO date \"" + date[0] + "\" on " + labelOf(el));
  }

  const scope: Element[] = [];
  for (const sel of args.roots) {
    const nodes = document.querySelectorAll(sel);
    if (!nodes.length) {
      failures.push("missing root " + sel);
      continue;
    }
    nodes.forEach((node) => { if (shown(node)) scope.push(node); });
  }
  if (!scope.length) failures.push("no visible sweep root");

  const seen = new Set<Element>();
  for (const root of scope) {
    const controls: Element[] = [];
    if (root.matches(INTERACTIVE)) controls.push(root);
    root.querySelectorAll(INTERACTIVE).forEach((el) => controls.push(el));
    for (const el of controls) {
      if (seen.has(el) || !shown(el)) continue;
      seen.add(el);
      const box = el.getBoundingClientRect();
      if ((box.width < 43.5 || box.height < 43.5) && !waived("hit", labelOf(el), el)) {
        failures.push("hit " + Math.round(box.width) + "x" + Math.round(box.height) + " on " + labelOf(el));
      }
    }
    const textEls: Element[] = [root];
    root.querySelectorAll("*").forEach((el) => textEls.push(el));
    for (const el of textEls) {
      if (!shown(el)) continue;
      const text = directText(el);
      if (text) checkText(el, text, getComputedStyle(el));
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const hint = el.getAttribute("placeholder") || "";
        if (hint && !el.value) checkText(el, hint, getComputedStyle(el, "::placeholder"));
      }
    }
  }

  return { failures, used };
}

/** Runs the sweep at 360 and 390. Throws through expect when a rule fails. */
export async function phoneSweep(page: Page, options: PhoneSweepOptions): Promise<void> {
  const widths = options.widths && options.widths.length ? options.widths : [360, 390];
  const exceptions = options.exceptions || [];
  const failures: string[] = [];
  const used = new Set<number>();
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 360 ? 780 : 844 });
    const report = await page.evaluate(sweepInPage, {
      roots: options.roots,
      exceptions,
    } satisfies SweepArgs);
    report.used.forEach((i) => used.add(i));
    report.failures.forEach((line) => failures.push(width + "px " + line));
  }
  exceptions.forEach((ex, i) => {
    if (!used.has(i)) failures.push("unused exception (" + ex.rule + "): " + ex.reason);
  });
  expect(failures, "phone sweep").toEqual([]);
}
