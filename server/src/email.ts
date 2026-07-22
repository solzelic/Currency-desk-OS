/* ============================================================
   Transactional email — one function, two backends.
   With RESEND_API_KEY + EMAIL_FROM set, sends via Resend's REST API
   (plain fetch, no SDK). Without them, sends are SIMULATED: the body
   is logged, so the whole signup / email-OTP flow can be built,
   demoed and tested before an email provider exists — the same
   pattern as src/sms.ts. Never throws.
   (SendGrid is a small addition if one-vendor billing is preferred.)
   ============================================================ */
import { randomInt, createHash, timingSafeEqual } from "node:crypto";

export type EmailStatus = "sent" | "simulated" | "failed";

export async function sendEmail(to: string, subject: string, body: { text: string; html?: string }): Promise<EmailStatus> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM; // e.g. "CurrencyDesk <noreply@mail.currencydesk.com>"
  if (!key || !from) {
    console.log(`[email simulated] to=${to} :: ${subject} :: ${body.text}`);
    return "simulated";
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text: body.text, html: body.html }),
    });
    if (!res.ok) {
      console.error(`[email failed] ${res.status} ${await res.text().catch(() => "")}`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error("[email failed]", err);
    return "failed";
  }
}

/* A 6-digit numeric verification code, zero-padded. */
export function makeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* Store only the hash; compare in constant time so a DB leak can't be
   replayed and timing can't be probed. */
export function hashCode(code: string): string {
  return sha256(code.trim());
}
export function codeMatches(input: string, storedHash: string): boolean {
  const a = Buffer.from(sha256((input || "").trim()), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* The sign-in code email — a returning user proving it's them on login. */
export function loginCodeEmail(code: string, name?: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your CurrencyDesk sign-in code`;
  const text =
    `${name ? name + ", enter" : "Enter"} this code to finish signing in to CurrencyDesk: ${code}.\n\n` +
    `It expires in 10 minutes. If you didn't just try to sign in, someone may have your password — change it.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${name ? name + ", enter" : "Enter"} this code to finish signing in:</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:34px;font-weight:700;letter-spacing:.28em;margin:20px 0;padding:16px 0;text-align:center;background:#f4f3f0;border-radius:12px">${code}</div>` +
    `<div style="font-size:13px;color:#8a8a8a">Expires in 10 minutes. If this wasn't you, someone may have your password — change it.</div>` +
    `</div>`;
  return { subject, text, html };
}

/* The verification email. Plain + a minimal branded HTML. */
export function verificationEmail(code: string, businessName: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your CurrencyDesk verification code`;
  const text =
    `Your CurrencyDesk verification code is ${code}.\n\n` +
    `Enter it to finish creating your desk${businessName ? ` for ${businessName}` : ""}. ` +
    `It expires in 10 minutes. If you didn't request this, you can ignore this email.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">Enter this code to finish creating your desk${businessName ? ` for <b style="color:#0a0a0a">${businessName}</b>` : ""}:</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:34px;font-weight:700;letter-spacing:.28em;margin:20px 0;padding:16px 0;text-align:center;background:#f4f3f0;border-radius:12px">${code}</div>` +
    `<div style="font-size:13px;color:#8a8a8a">It expires in 10 minutes. If you didn't request this, ignore this email.</div>` +
    `</div>`;
  return { subject, text, html };
}
