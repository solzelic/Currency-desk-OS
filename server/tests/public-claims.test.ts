import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/check-public-claims.mjs");

function probe(html: string, rel = ""): { ok: boolean; out: string } {
  try {
    const args = [script, "--probe", html];
    if (rel) args.push(rel);
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    return { ok: true, out };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}` };
  }
}

describe("public marketing claims", () => {
  it("served pages do not repeat banned claims", () => {
    const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(out).toMatch(/^ok /);
  });

  it("flags a non-breaking space between desks and claimed", () => {
    const result = probe("desks&nbsp;claimed");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/desks claimed/);
  });

  it("flags a line break between desks and claimed", () => {
    const result = probe("desks\nclaimed");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/desks claimed/);
  });

  it("flags a tag between report and ready", () => {
    const result = probe("Report <b>ready</b>");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/Report ready/);
  });

  it("flags uppercase EFTR next to LIVE", () => {
    const result = probe("EFTR LIVE");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/EFTR next to Live/);
  });

  it("does not treat the word structuring as an STR", () => {
    const result = probe("STRUCTURING stays on the worksheet");
    expect(result.ok).toBe(true);
  });

  it("flags a dotted OFAC", () => {
    const result = probe("O.F.A.C. list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OFAC/);
  });

  it("flags a dotted U.N. sanctions list", () => {
    const result = probe("U.N. sanctions list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/UN sanctions/);
  });

  it("flags OSFI", () => {
    const result = probe("checked with OSFI");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OSFI/);
  });

  it("flags a singular real shop", () => {
    const result = probe("a real shop");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a zero-width space inside real shops", () => {
    const result = probe("real&#8203;shops");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a soft hyphen inside real shops", () => {
    const result = probe("real&shy;shops");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real shop/);
  });

  it("flags a soft hyphen inside OFAC", () => {
    const result = probe("O&shy;FAC");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/OFAC/);
  });

  it("flags a soft hyphen inside sanctions", () => {
    const result = probe("sanc&shy;tions");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/sanctions/);
  });

  it("flags sanctions screening when it is not the honest negation", () => {
    const result = probe("sanctions screening included");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/sanctions screening/);
  });

  it("allows the honest sentence that sanctions screening is not connected", () => {
    const result = probe("Sanctions screening is not connected");
    expect(result.ok).toBe(true);
  });

  it("flags screened against", () => {
    const result = probe("screened against a list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/screened against/);
  });

  it("flags most popular", () => {
    const result = probe("Most popular");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/most popular/);
  });

  it("flags most chosen", () => {
    const result = probe("Most chosen");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/most chosen/);
  });

  it("flags billed separately", () => {
    const result = probe("billed separately per file");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/billed separately/);
  });

  it("flags a UN list", () => {
    const result = probe("checked on the UN list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/UN list/);
  });

  it("flags a United Nations list", () => {
    const result = probe("the United Nations list");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/United Nations list/);
  });

  it("flags best protection", () => {
    const result = probe("Best protection");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/best protection/);
  });

  it("flags in seconds, including a zero-width split", () => {
    const result = probe("serve a customer in&#8203;seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in seconds/);
  });

  it("flags in N seconds, including a soft hyphen", () => {
    const result = probe("done in 4&shy;seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in N seconds/);
  });

  it("flags in N minutes, including a soft hyphen", () => {
    const result = probe("ready in 4&shy;minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in N minutes/);
  });

  it("flags a minutes duration, including a zero-width split", () => {
    const result = probe("wait 15&#8203;minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/minutes/);
  });

  it("flags a few minutes", () => {
    const result = probe("within a few minutes");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/minutes/);
  });

  it("flags N seconds, including a written number", () => {
    const result = probe("ninety seconds");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/N seconds/);
  });

  it("flags same afternoon, including a zero-width split", () => {
    const result = probe("live the same&#8203;afternoon");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same afternoon/);
  });

  it("flags same day, including a dotted split", () => {
    const result = probe("usually the s.a.m.e day");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same day/);
  });

  it("flags about a week, including a soft hyphen", () => {
    const result = probe("about a&shy;week");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/about a week/);
  });

  it("flags within a week, including an entity split", () => {
    const result = probe("within&#8203;a week");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/within a week/);
  });

  it("flags an N-minute compound, including a hyphen entity", () => {
    const result = probe("a 10&#45;minute setup");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/N-minute/);
  });

  it("flags same-day, including a hyphen entity", () => {
    const result = probe("same&#45;day answers");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/same-day/);
  });

  it("flags a fortnight, including a zero-width split", () => {
    const result = probe("within a fort&#8203;night");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/fortnight/);
  });

  it("flags within N hours, including a zero-width split", () => {
    const result = probe("ready within 24&#8203;hours");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/within N hours/);
  });

  it("flags in N hours, including a soft hyphen", () => {
    const result = probe("back in 2&shy;hours");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/in N hours/);
  });

  it("flags 24/7, including a slash entity", () => {
    const result = probe("open 24&#47;7");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/24\/7/);
  });

  it("flags real-time, including a hyphen entity", () => {
    const result = probe("real&#45;time rates");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/real-time/);
  });

  it("flags live rates, including a soft hyphen", () => {
    const result = probe("live&shy;rates on the board");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/live rates/);
  });

  it("flags same-day, ten-minute and real-time when the hyphen is a dash variant", () => {
    const dashes = ["&#8208;", "&#8209;", "&#8210;", "&#8211;", "&#8212;", "&#8213;", "&#8722;"];
    for (const dash of dashes) {
      const result = probe(`same${dash}day setup, a ten${dash}minute wait, real${dash}time rates`);
      expect(result.ok).toBe(false);
      expect(result.out).toMatch(/same-day/);
      expect(result.out).toMatch(/N-minute/);
      expect(result.out).toMatch(/real-time/);
    }
  });

  it("flags 48h and Nh, including a zero-width split", () => {
    const result = probe("ready within 48&#8203;h");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/Nh/);
  });

  it("flags N hrs, including a soft hyphen", () => {
    const result = probe("back in 2&shy;hrs");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/N hrs/);
  });

  it("flags under N hours, including a zero-width split", () => {
    const result = probe("in under 2&#8203;hours");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/under N hours/);
  });

  it("flags replying today, including a soft hyphen", () => {
    const result = probe("replying&shy;today");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/replying today/);
  });

  it("flags live rates in a meta description", () => {
    const result = probe('<meta name="description" content="live rates, till and ledger">');
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/live rates/);
  });

  it("allows the product name Live rate board and still flags live rates", () => {
    expect(probe("Live rate board").ok).toBe(true);
    expect(probe("Every plan includes the live rate board.").ok).toBe(true);
    const rates = probe("the live rate board shows live rates");
    expect(rates.ok).toBe(false);
    expect(rates.out).toMatch(/live rates/);
  });

  it("flags handling real work, see it live, and a live board", () => {
    const work = probe("The service is live and handling real work");
    expect(work.ok).toBe(false);
    expect(work.out).toMatch(/handling real work/);
    const demo = probe("See it&shy;live");
    expect(demo.ok).toBe(false);
    expect(demo.out).toMatch(/see it live/);
    const board = probe("A live&#8203;board, built from market rates");
    expect(board.ok).toBe(false);
    expect(board.out).toMatch(/live board/);
    expect(probe("Live rate board").ok).toBe(true);
    expect(probe("Every plan includes the live rate board.").ok).toBe(true);
  });

  it("allows an exact regulator deadline only on the compliance and FAQ pages", () => {
    const line = "SMR within 24 hours for terrorism financing. LCTR within 15 calendar days. SAR within 30 days. Cash is added across a static 24 hours. A worksheet within 3 business days.";
    expect(probe(line).ok).toBe(false);
    expect(probe(line, "web/index.html").ok).toBe(false);
    expect(probe(line, "web/compliance.html").ok).toBe(true);
    expect(probe(line, "web/faq.html").ok).toBe(true);
  });

  it("does not let a longer sentence borrow the SMR clause", () => {
    const line = "We file your SMR within 24 hours";
    expect(probe(line).ok).toBe(false);
    expect(probe(line, "web/compliance.html").ok).toBe(false);
    expect(probe(line, "web/faq.html").ok).toBe(false);
  });

  it("keeps the SMR clause only when it is the whole clause on the compliance and FAQ pages", () => {
    const clause = "SMR within 24 hours for terrorism financing";
    expect(probe(clause, "web/compliance.html").ok).toBe(true);
    expect(probe(clause, "web/faq.html").ok).toBe(true);
    expect(probe(clause, "web/index.html").ok).toBe(false);
    expect(probe("We file your SMR within 24 hours for terrorism financing", "web/compliance.html").ok).toBe(false);
    expect(probe("SMR within 24 hours, guaranteed", "web/compliance.html").ok).toBe(false);
  });

  it("flags 48-hour, less than an hour, overnight, always current, and plenty of shops", () => {
    expect(probe("a 48-hour setup").out).toMatch(/48-hour/);
    expect(probe("ready in less than an hour").out).toMatch(/less than an hour/);
    expect(probe("set up overnight").out).toMatch(/overnight/);
    expect(probe("the board is always current").out).toMatch(/always current/);
    expect(probe("plenty of shops run on it").out).toMatch(/plenty of shops/);
    expect(probe("24-hour rule").ok).toBe(true);
    expect(probe("not an hour with a calculator").ok).toBe(true);
  });

  it("flags a hyphen entity, a thin space, and a fullwidth dash", () => {
    expect(probe("same&hyphen;day setup").out).toMatch(/same-day/);
    expect(probe("live&thinsp;rates on the board").out).toMatch(/live rates/);
    expect(probe("real\uFF0Dtime rates").out).toMatch(/real-time/);
    expect(probe("a 48&dash;hour setup").out).toMatch(/48-hour/);
    expect(probe("ready within&ensp;2 hours").out).toMatch(/within N hours/);
    expect(probe("ready within&#8194;2 hours").out).toMatch(/within N hours/);
    expect(probe("ready within&emsp;2 hours").out).toMatch(/within N hours/);
    expect(probe("ready within&#8195;2 hours").out).toMatch(/within N hours/);
    expect(probe("ready within&hairsp;2 hours").out).toMatch(/within N hours/);
    expect(probe("ready within&#8202;2 hours").out).toMatch(/within N hours/);
  });

  it("flags live-rates in the body and in a meta description", () => {
    expect(probe("see the live-rates").out).toMatch(/live rates/);
    expect(probe("see the live&#8209;rates").out).toMatch(/live rates/);
    expect(probe('<meta name="description" content="live-rates">').out).toMatch(/live rates/);
    expect(probe('<meta name="description" content="live&#8209;rates">').out).toMatch(/live rates/);
  });

  it("flags a 2-hour setup, within the hour, next-day, reply today, and a moving board", () => {
    expect(probe("a 2-hour setup").out).toMatch(/N-hour/);
    expect(probe("within the hour").out).toMatch(/within the hour/);
    expect(probe("next-day answers").out).toMatch(/next-day/);
    expect(probe("We reply today").out).toMatch(/reply today/);
    expect(probe("live rate boards everywhere").out).toMatch(/live rate boards/);
    const moving = probe("Live rate board rates move as the market moves");
    expect(moving.ok).toBe(false);
    expect(moving.out).toMatch(/as the market moves/);
    expect(probe("Live rate board").ok).toBe(true);
    expect(probe("24-hour rule").ok).toBe(true);
  });

  it("allows only the exact 24-hour rule name, and flags the other hour shapes", () => {
    expect(probe("a 24-hour setup").ok).toBe(false);
    expect(probe("24-hour onboarding").ok).toBe(false);
    expect(probe("24-hour rule").ok).toBe(true);
    expect(probe("24-hour aggregation rule").ok).toBe(true);
    expect(probe("a 48 hour setup").out).toMatch(/N hour/);
    expect(probe("a 2 hour wait").out).toMatch(/N hour/);
    expect(probe("a two-hour wait").out).toMatch(/two-hour/);
    expect(probe("less than two hours").out).toMatch(/less than an hour/);
    expect(probe("set up over-night").out).toMatch(/overnight/);
    expect(probe("Replies today").out).toMatch(/replies today/);
    const borrowed = "SMR within 24 hours for terrorism financing, guaranteed.";
    expect(probe(borrowed, "web/compliance.html").ok).toBe(false);
    expect(probe(borrowed, "web/faq.html").ok).toBe(false);
    expect(probe("SMR within 24 hours for terrorism financing, otherwise 3 business days", "web/compliance.html").ok).toBe(true);
  });

  it("flags every second beside the Live rate board name", () => {
    expect(probe("Live rate board").ok).toBe(true);
    const line = probe("Live rate board, updated every second");
    expect(line.ok).toBe(false);
    expect(line.out).toMatch(/every second/);
  });

  it("flags an unquoted meta attribute", () => {
    const result = probe("<meta name=description content=live rates>");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/live rates/);
  });

  it("flags a tag inside a word", () => {
    const result = probe("li<b>ve rates</b> on the board");
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/live rates/);
  });

  it("does not let a later report name allow a deadline", () => {
    for (const line of ["Onboard within 2 hours, STR ready.", "in 2 hours (CTR included)"]) {
      expect(probe(line).ok).toBe(false);
      expect(probe(line, "web/compliance.html").ok).toBe(false);
      expect(probe(line, "web/faq.html").ok).toBe(false);
    }
  });

  it("allows the moment a deal is written and an untimed launch", () => {
    const result = probe("the second it happens. a second shop. an on-site launch week. We have not timed it.");
    expect(result.ok).toBe(true);
  });
});
