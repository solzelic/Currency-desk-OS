#!/usr/bin/env node
/* ============================================================
   Compare two captures of sign-up v2.1 made by the pack's capture.cjs
   (build doc §10): the frozen prototype (baseline) and this build.

     node scripts/compare-signup-capture.mjs <baseline-dir> <build-dir> [out.json]

   Per state and size it checks what the build doc asks for:
     · no page scroll at desktop, laptop and the 1440×900 check;
     · the same inner scrollers (currency list, agreement, ID-line law panel);
     · every visible element of the baseline present in the build, matched
       by tag and text in document order, with its box within ±1px and the
       same font, colour, background, radius and border.
   It reports; it does not decide. A difference the build doc requires (the
   real Home behind Day 1, the provider's own windows, Stripe's card frame)
   shows up here and is explained in the PR, not hidden.
   ============================================================ */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const [, , BASE, BUILD, OUT] = process.argv;
if (!BASE || !BUILD) { console.error("usage: compare-signup-capture.mjs <baseline> <build> [out.json]"); process.exit(2); }
const NO_SCROLL = new Set(["desktop", "laptop", "check"]);
const TOL = 1;

/* The four drifting currency glyphs behind the card (aria-hidden, cdRise) are
   ambient decoration whose position depends on the moment of capture. */
const DECOR = new Set(["$", "€", "£", "¥"]);
const shown = (list) => list.filter((e) => !(e.tag === "span" && DECOR.has((e.text ?? "").trim())));
const key = (e) => `${e.tag}|${e.role ?? ""}|${(e.text ?? "").trim()}`;
function match(a, b) {
  /* in document order, each baseline element takes the next unused build element with the same key */
  const pool = new Map();
  b.forEach((e, i) => { const k = key(e); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(i); });
  const used = new Set(), pairs = [], missing = [];
  for (const e of a) {
    const list = pool.get(key(e)) ?? [];
    const j = list.find((x) => !used.has(x));
    if (j == null) { missing.push(e); continue; }
    used.add(j); pairs.push([e, b[j]]);
  }
  return { pairs, missing, extra: b.filter((_, i) => !used.has(i)) };
}

const states = readdirSync(BASE).filter((f) => f.endsWith(".json") && !f.startsWith("00-tour")).map((f) => f.replace(/\.json$/, ""));
const report = [];
for (const s of states.sort()) {
  const [state, size] = [s.slice(0, s.lastIndexOf(".")), s.slice(s.lastIndexOf(".") + 1)];
  const b = JSON.parse(readFileSync(path.join(BASE, s + ".json"), "utf8"));
  const file = path.join(BUILD, s + ".json");
  if (!existsSync(file)) { report.push({ state, size, captured: false }); continue; }
  const c = JSON.parse(readFileSync(file, "utf8"));
  const { pairs, missing, extra } = match(shown(b.elements), shown(c.elements));
  const moved = [], styled = [];
  for (const [x, y] of pairs) {
    const d = Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.w - y.w), Math.abs(x.h - y.h));
    if (d > TOL) moved.push({ text: x.text, tag: x.tag, base: [x.x, x.y, x.w, x.h], build: [y.x, y.y, y.w, y.h], d });
    const diff = ["font", "color", "bg", "radius", "border"].filter((k) => (x[k] ?? "") !== (y[k] ?? ""));
    if (diff.length) styled.push({ text: x.text, tag: x.tag, diff: Object.fromEntries(diff.map((k) => [k, [x[k] ?? null, y[k] ?? null]])) });
  }
  const scrollers = (z) => (z.scrollers ?? []).map((q) => q.what).sort().join(",");
  report.push({
    state, size, captured: true,
    pageScrolls: c.pageScrolls, pageScrollAllowed: !NO_SCROLL.has(size),
    scrollersSame: scrollers(b) === scrollers(c), scrollers: { base: scrollers(b), build: scrollers(c) },
    elements: shown(b.elements).length, matched: pairs.length, withinTolerance: pairs.length - moved.length,
    moved: moved.length, styled: styled.length, missing: missing.length, extra: extra.length,
    detail: { moved: moved.slice(0, 12), styled: styled.slice(0, 12), missing: missing.slice(0, 12).map((e) => `${e.tag} ${e.text}`), extra: extra.slice(0, 12).map((e) => `${e.tag} ${e.text}`) },
  });
}
const exact = report.filter((r) => r.captured && !r.moved && !r.styled && !r.missing && !r.extra && r.scrollersSame && (r.pageScrollAllowed || !r.pageScrolls));
const scrollFail = report.filter((r) => r.captured && !r.pageScrollAllowed && r.pageScrolls);
const summary = { compared: report.length, captured: report.filter((r) => r.captured).length, exact: exact.length, pageScrollFailures: scrollFail.map((r) => `${r.state}.${r.size}`) };
console.log(JSON.stringify(summary, null, 1));
for (const r of report.filter((r) => !exact.includes(r))) {
  console.log(`${r.state}.${r.size}: ${r.captured ? `moved ${r.moved}, styled ${r.styled}, missing ${r.missing}, extra ${r.extra}${r.scrollersSame ? "" : `, scrollers ${r.scrollers.base}→${r.scrollers.build}`}${!r.pageScrollAllowed && r.pageScrolls ? ", PAGE SCROLLS" : ""}` : "not captured"}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, report }, null, 1));
