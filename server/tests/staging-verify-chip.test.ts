/* The staging fresh path shows the confirm code in a chip.
   The emailed path keeps the resend link and the old sentence. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const html = readFileSync(join(root, "web/onboarding.html"), "utf8");

function grab(src: string, name: string): string {
  const start = src.indexOf(name + ": function");
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("missing " + name);
}

const CD = { verify: { channel: "email", sentTo: "owner@shop.test", code: "" } };
const verifyCopy = (new Function("CD", "return ({ " + grab(html, "verifyCopy") + " });")(CD) as {
  verifyCopy: (d: { ownerEmail?: string }) => { help: string; resend: string; fixTail: string };
}).verifyCopy;

function contrast(fg: string, bg: string): number {
  const channel = (hex: string, shift: number) => {
    const c = ((parseInt(hex.slice(1), 16) >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) =>
    0.2126 * channel(hex, 16) + 0.7152 * channel(hex, 8) + 0.0722 * channel(hex, 0);
  const lighter = Math.max(lum(fg), lum(bg));
  const darker = Math.min(lum(fg), lum(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("confirm code on the staging fresh path", () => {
  it("shows a Staging code chip and hides resend only when the code is on screen", () => {
    CD.verify.code = "177636";
    const shown = verifyCopy({ ownerEmail: "owner@shop.test" });
    expect(shown.help).toBe("Enter the code below.");
    expect(shown.resend).toBe("");
    expect(shown.fixTail).toBe(". You\u2019ll need this address every time you sign in.");
    expect(shown.fixTail).not.toMatch(/\u2014|\u2013/);
    expect(html).toContain("Go back and change it<\\u002Fbutton>{{ verifyFixTail }}");
    expect(html).not.toContain("Go back and change it<\\u002Fbutton> {{ verifyFixTail }}");
    const chip = html.slice(html.indexOf("data-staging-code"), html.indexOf("data-staging-code") + 900);
    expect(chip).toContain("Staging code");
    expect(chip).toContain("font-family:var(--m)");
    expect(chip).toContain("font-size:20px");
    expect(chip).toContain("color:#17140F");
    expect(chip).toContain("min-height:44px");
    expect(chip).toContain(">Copy<");
    expect(contrast("#17140F", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(html).toContain("{{ verifyShowResend }}");
    const gated = html.slice(html.indexOf("{{ verifyShowResend }}"), html.indexOf("{{ verifyShowResend }}") + 800);
    expect(gated).toContain("Send it again");
    CD.verify.code = "";
    const mailed = verifyCopy({ ownerEmail: "owner@shop.test" });
    expect(mailed.help).toContain("emailed a 6-digit code");
    expect(mailed.resend).toBe("No email yet?");
    expect(mailed.fixTail).toContain("\u2014");
  });
});
