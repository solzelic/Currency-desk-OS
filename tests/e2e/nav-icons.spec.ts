/* The module strip is one icon set. Dark mode was painting the
   artwork's near-black strokes on a near-black bar, so Reports
   kept a short green tick and Pricing kept the slash. */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const WIDTHS = [360, 390, 430, 600, 1280] as const;
const SHOTS = path.join(process.cwd(), "docs/pr-shots/nav-icons");

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const parts: Buffer[] = [];
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || !channels) throw new Error("expected an 8-bit rgb png");
    } else if (type === "IDAT") parts.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const rgba = new Uint8Array(width * height * 4);
  const stride = width * channels;
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? cur[i - channels]! : 0;
      const up = prev[i]!;
      const ul = i >= channels ? prev[i - channels]! : 0;
      let value = row[i]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - ul;
        const pa = Math.abs(guess - left);
        const pb = Math.abs(guess - up);
        const pc = Math.abs(guess - ul);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      cur[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      rgba[to] = cur[from]!;
      rgba[to + 1] = cur[from + 1]!;
      rgba[to + 2] = cur[from + 2]!;
      rgba[to + 3] = channels === 4 ? cur[from + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, rgba };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrast(a: number[], b: number[]): number {
  const lum = (rgb: number[]) => 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
  const hi = Math.max(lum(a), lum(b));
  const lo = Math.min(lum(a), lum(b));
  return (hi + 0.05) / (lo + 0.05);
}

function over(stroke: number[], ground: number[], opacity: number): number[] {
  return stroke.map((part, i) => part * opacity + ground[i]! * (1 - opacity));
}

function pixel(img: { width: number; rgba: Uint8Array }, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!];
}

type Rgb = [number, number, number];
type Reading = {
  id: string;
  shapes: number;
  strokes: string[];
  widths: string[];
  effects: string[];
  label: Rgb;
  labelPoint: { x: number; y: number };
  labelCenter: { x: number; y: number };
  hit: string;
  iconOpacity: number;
  iconPoint: { x: number; y: number };
  height: number;
  width: number;
  active: boolean;
  weight: number;
  bar: number;
  barColor: Rgb | null;
};

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
}

async function settle(page: Page) {
  const win = page.locator(".win.show.active").first();
  if (await win.count()) await expect(win).toHaveCSS("transform", "none");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
}

async function readNav(page: Page): Promise<Reading[]> {
  return page.evaluate(() => {
    const rgb = (value: string): [number, number, number] | null => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const tabs = [...document.querySelectorAll("#appbar .app-btn")];
    return tabs.map((tab) => {
      const shapes = [...tab.querySelectorAll("svg path, svg rect, svg circle, svg line, svg polyline, svg polygon")];
      const label = tab.querySelector(".al");
      const box = tab.getBoundingClientRect();
      const labelBox = label ? label.getBoundingClientRect() : box;
      const bar = getComputedStyle(tab, "::after");
      return {
        id: tab.getAttribute("data-app") || "",
        shapes: shapes.length,
        strokes: [...new Set(shapes.map((el) => getComputedStyle(el).stroke))],
        widths: [...new Set(shapes.map((el) => getComputedStyle(el).strokeWidth))],
        effects: [...new Set(shapes.map((el) => getComputedStyle(el).vectorEffect))],
        label: rgb(label ? getComputedStyle(label).color : "") || [0, 0, 0],
        labelPoint: { x: labelBox.left + Math.min(8, labelBox.width / 2), y: labelBox.top + labelBox.height / 2 },
        labelCenter: { x: labelBox.left + labelBox.width / 2, y: labelBox.top + labelBox.height / 2 },
        hit: (() => {
          const el = document.elementFromPoint(labelBox.left + labelBox.width / 2, labelBox.top + labelBox.height / 2);
          const owner = el && el.closest("[data-app]");
          return owner ? owner.getAttribute("data-app") || "" : "";
        })(),
        iconOpacity: Number(getComputedStyle(tab.querySelector("svg") || tab).opacity) || 1,
        /* Left padding, clear of the glyph and the label. */
        iconPoint: { x: box.left + 8, y: box.top + box.height / 2 },
        height: box.height,
        width: box.width,
        active: tab.classList.contains("is-active"),
        weight: Number(getComputedStyle(label || tab).fontWeight) || 400,
        bar: bar.content === "none" ? 0 : Number.parseFloat(bar.height) || 0,
        barColor: rgb(bar.backgroundColor),
      };
    });
  });
}

async function paint(page: Page) {
  const shot = decodePng(await page.screenshot());
  const cssWidth = page.viewportSize()?.width || shot.width;
  const scale = shot.width / cssWidth;
  const sample = (x: number, y: number) => pixel(shot, Math.round(x * scale), Math.round(y * scale));
  return { shot, sample };
}

test("every nav tab uses one icon stroke and clears contrast", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("cdos_theme", "dark"));
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await settle(page);

  if (process.env.NAV_SHOT && process.env.NAV_SHOT !== "states") {
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((mode) => {
        const themeApi = (window as unknown as { CDOS: { theme: { set: (value: string) => void } } }).CDOS.theme;
        themeApi.set(mode);
      }, theme);
      if (theme === "dark") {
        await page.waitForFunction(() => {
          const bar = document.getElementById("appbar");
          if (!bar) return false;
          return getComputedStyle(bar).backgroundColor.startsWith("rgba(29, 28, 25");
        });
        await page.waitForTimeout(400);
      }
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        const bar = page.locator("#appbar");
        if (await bar.isVisible()) {
          await page.evaluate(() => {
            const strip = document.getElementById("appbar");
            const tab = document.querySelector("#appbar [data-app='reports']");
            if (strip && tab instanceof HTMLElement) strip.scrollLeft = Math.max(0, tab.offsetLeft - 12);
          });
          if (width >= 600) {
            await page.locator("#appbar [data-app='reports']").click();
            await expect(page.locator("#appbar [data-app='reports']")).toHaveClass(/is-active/);
          }
        }
        const file = path.join(SHOTS, `${process.env.NAV_SHOT}-${theme}-${width}.png`);
        await page.screenshot({ path: file });
        expect(decodePng(readFileSync(file)).width, file).toBe(width);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      (window as unknown as { CDOS: { theme: { set: (value: string) => void } } }).CDOS.theme.set("dark");
    });
  }

  const seen: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((mode) => {
      (window as unknown as { CDOS: { theme: { set: (value: string) => void } } }).CDOS.theme.set(mode);
    }, theme);
    if (theme === "dark") {
      await page.waitForFunction(() => {
        const bar = document.getElementById("appbar");
        if (!bar) return false;
        return getComputedStyle(bar).backgroundColor.startsWith("rgba(29, 28, 25");
      });
      await page.waitForTimeout(400);
    }
    for (const width of [1280, 600] as const) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      await page.evaluate(() => {
        const strip = document.getElementById("appbar");
        const tab = document.querySelector("#appbar [data-app='reports']");
        if (strip && tab instanceof HTMLElement) strip.scrollLeft = Math.max(0, tab.offsetLeft - 12);
      });
      await page.locator("#appbar [data-app='reports']").click();
      await expect(page.locator("#appbar [data-app='reports']")).toHaveClass(/is-active/);
      const token = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--cd-green)";
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      const rows = await readNav(page);
      const { sample } = await paint(page);
      const ink = "rgb(23, 20, 15)";
      const quiet = "rgb(236, 234, 227)";
      expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(["reports", "pricing"]));
      for (const row of rows) {
        expect(row.shapes, row.id).toBeGreaterThan(0);
        const strokeName = theme === "light" ? ink : row.active ? token : quiet;
        expect(row.strokes, `${theme} ${width} ${row.id}`).toEqual([strokeName]);
        expect(row.iconOpacity, `${theme} ${width} ${row.id} opacity`).toBeCloseTo(theme === "dark" && !row.active ? 0.72 : 1, 2);
        expect(row.widths, row.id).toEqual(["1.75px"]);
        expect(row.effects, row.id).toEqual(["non-scaling-stroke"]);
        expect(row.height, row.id).toBeGreaterThanOrEqual(44);
        expect(row.width, row.id).toBeGreaterThanOrEqual(44);
        const onScreen = row.iconPoint.x >= 16 && row.iconPoint.x <= width - 100 && row.iconPoint.y >= 8;
        const labelOnScreen = row.labelCenter.x >= 16 && row.labelCenter.x <= width - 100 && row.labelCenter.y >= 8;
        if (labelOnScreen) expect(row.hit, `${theme} ${width} ${row.id} hit`).toBe(row.id);
        if (onScreen) {
          const ground = sample(row.iconPoint.x, row.iconPoint.y);
          const stroke = row.strokes[0]!.match(/\d+/g)!.slice(0, 3).map(Number);
          const iconRatio = contrast(over(stroke, ground, row.iconOpacity), ground);
          const labelRatio = contrast(row.label, ground);
          expect(iconRatio, `${theme} ${width} ${row.id} icon`).toBeGreaterThanOrEqual(3);
          expect(labelRatio, `${theme} ${width} ${row.id} label`).toBeGreaterThanOrEqual(4.5);
          if (row.active) {
            expect(row.barColor, row.id).not.toBeNull();
            const barRatio = contrast(row.barColor!, ground);
            expect(barRatio, `${theme} ${width} bar`).toBeGreaterThanOrEqual(3);
            seen.push(`${theme} ${width} ${row.id} icon ${iconRatio.toFixed(2)} label ${labelRatio.toFixed(2)} bar ${barRatio.toFixed(2)} ground ${ground.map((n) => Math.round(n)).join(",")}`);
          } else {
            seen.push(`${theme} ${width} ${row.id} icon ${iconRatio.toFixed(2)} label ${labelRatio.toFixed(2)} ground ${ground.map((n) => Math.round(n)).join(",")}`);
          }
        }
        if (row.active) {
          expect(row.weight, row.id).toBeGreaterThanOrEqual(700);
          expect(row.bar, row.id).toBeGreaterThanOrEqual(3);
          const want = (theme === "dark" ? token : ink).match(/\d+/g)!.slice(0, 3).map(Number);
          expect(row.barColor, `${theme} ${width} ${row.id} bar colour`).toEqual(want);
        }
      }
      const reports = rows.find((row) => row.id === "reports");
      const pricing = rows.find((row) => row.id === "pricing");
      expect(reports?.shapes).toBeGreaterThanOrEqual(4);
      expect(pricing?.shapes).toBeGreaterThanOrEqual(3);
      await page.evaluate(() => {
        const strip = document.getElementById("appbar");
        if (strip) strip.scrollLeft = strip.scrollWidth;
      });
      const end = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll("#appbar .app-btn")];
        const last = tabs[tabs.length - 1];
        const rail = document.querySelector(".edge-rail .rail-trio");
        return {
          id: last ? last.getAttribute("data-app") : "",
          tabRight: last ? last.getBoundingClientRect().right : 0,
          buttonLeft: rail ? rail.getBoundingClientRect().left : 0,
        };
      });
      expect(end.tabRight, `${theme} ${width} ${end.id} clears the rail`).toBeLessThan(end.buttonLeft);
      seen.push(`${theme} ${width} end ${end.id} tab ${end.tabRight.toFixed(0)} rail ${end.buttonLeft.toFixed(0)}`);
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  const tabs = page.locator("#appbar .app-btn");
  const tabCount = await tabs.count();
  expect(tabCount).toBeGreaterThan(2);
  for (let i = 0; i < tabCount; i++) {
    await expect(tabs.nth(i)).toHaveAttribute("role", "tab");
    await expect(tabs.nth(i)).toHaveJSProperty("tabIndex", 0);
  }
  await expect(page.locator("#appbar .app-btn[aria-selected='true']")).toHaveCount(1);
  const firstId = await tabs.first().getAttribute("data-app");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  const movedId = await page.evaluate(() => document.activeElement?.getAttribute("data-app"));
  expect(movedId, "ArrowRight moves to the next tab").not.toBe(firstId);
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.first()).toBeFocused();
  const pricing = page.locator("#appbar [data-app='pricing']");
  await pricing.focus();
  await page.keyboard.press("Enter");
  await expect(pricing).toHaveClass(/is-active/);
  await expect(pricing).toHaveAttribute("aria-selected", "true");
  const dashboard = page.locator("#appbar [data-app='dashboard']");
  await dashboard.focus();
  await page.keyboard.press("Space");
  await expect(dashboard).toHaveClass(/is-active/);
  await expect(dashboard).toHaveAttribute("aria-selected", "true");

  const rings: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((mode) => {
      (window as unknown as { CDOS: { theme: { set: (value: string) => void } } }).CDOS.theme.set(mode);
    }, theme);
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0);
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return null;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-app"),
        visible: el.matches(":focus-visible"),
        outline: style.outlineColor,
        width: Number.parseFloat(style.outlineWidth) || 0,
        left: box.left,
        top: box.top,
        boxWidth: box.width,
        boxHeight: box.height,
      };
    });
    expect(ring?.visible, `${theme} focus ring`).toBe(true);
    expect(ring!.width, `${theme} focus ring`).toBeGreaterThanOrEqual(2);
    const { sample } = await paint(page);
    const outline = ring!.outline.match(/\d+/g)!.slice(0, 3).map(Number);
    const x = ring!.left + ring!.boxWidth / 2;
    let painted: number[] | null = null;
    for (let y = ring!.top + 1; y < ring!.top + 12; y += 1) {
      const point = sample(x, y);
      const delta = Math.abs(point[0]! - outline[0]!) + Math.abs(point[1]! - outline[1]!) + Math.abs(point[2]! - outline[2]!);
      if (delta < 48) { painted = point; break; }
    }
    expect(painted, `${theme} focus ring is painted`).not.toBeNull();
    const ground = sample(ring!.left + 10, ring!.top + ring!.boxHeight / 2);
    const ratio = contrast(painted!, ground);
    expect(ratio, `${theme} focus ring contrast`).toBeGreaterThanOrEqual(3);
    rings.push(`${theme} focus ${ring!.id} ${ratio.toFixed(2)} ring ${painted!.map((n) => Math.round(n)).join(",")} ground ${ground.map((n) => Math.round(n)).join(",")}`);
  }

  if (process.env.NAV_SHOT === "states") {
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((mode) => {
        (window as unknown as { CDOS: { theme: { set: (value: string) => void } } }).CDOS.theme.set(mode);
      }, theme);
      await page.waitForTimeout(400);
      for (const width of [1280, 600] as const) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        await page.mouse.move(0, 0);
        await page.evaluate(() => {
          const strip = document.getElementById("appbar");
          const tab = document.querySelector("#appbar [data-app='reports']");
          if (strip && tab instanceof HTMLElement) strip.scrollLeft = Math.max(0, tab.offsetLeft - 12);
        });
        const reports = page.locator("#appbar [data-app='reports']");
        await reports.click();
        await expect(reports).toHaveClass(/is-active/);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `selected-${theme}-${width}.png`) });
        const idle = page.locator("#appbar [data-app='reports'] + .app-btn");
        await idle.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
        await idle.hover();
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `hover-${theme}-${width}.png`) });
        await page.mouse.move(0, 0);
        await idle.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS, `focus-${theme}-${width}.png`) });
      }
    }
  }
  console.log(seen.join("\n"));
  console.log(rings.join("\n"));
});
