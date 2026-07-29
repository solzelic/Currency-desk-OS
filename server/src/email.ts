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

/* The invitation. What an accepted applicant gets when an operator moves
   them to "invited": their reference, and the one link that starts the desk.
   Deliberately short — the next thing they should do is create it. */
/* Somebody has picked their application up. Sent the moment they move into
   review, because the gap between "we got it" and "you're in" is where an
   applicant decides we are not serious — and it costs nothing to say so. */
export function reviewEmail(opts: { name?: string | null }): { subject: string; text: string; html: string } {
  const who = opts.name ? `${opts.name}, we` : "We";
  const subject = "We're looking at your CurrencyDesk application";
  const text =
    `${who}'ve got your application and it's with us now.\n\n` +
    `Someone will call you shortly to talk it through — no preparation needed, ` +
    `we mostly want to hear how your desk runs today.\n\n` +
    `If anything changes in the meantime, just reply to this email.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${who}'ve got your application and it's with us now.</div>` +
    `<div style="margin:20px 0;padding:14px 16px;background:#f4f3f0;border-radius:12px;font-size:14px;line-height:1.6;color:#444">` +
    `Someone will call you shortly to talk it through. No preparation needed \u2014 we mostly want to hear how your desk runs today.` +
    `</div>` +
    `<div style="font-size:13px;color:#8a8a8a;line-height:1.6">If anything changes in the meantime, just reply to this email.</div>` +
    `</div>`;
  return { subject, text, html };
}

export function inviteEmail(opts: { name?: string | null; reference: string; origin: string }): { subject: string; text: string; html: string } {
  const who = opts.name ? `${opts.name}, you` : "You";
  /* Straight into setup, with their code already in the link so most people
     never type it. NOT /signup — that is the application they have already
     filled in, and sending an accepted operator back to it is the one thing
     this email must not do. */
  const link = `${opts.origin}/onboarding/${encodeURIComponent(opts.reference)}`;
  const subject = "You're in — set up your CurrencyDesk";
  const text =
    `${who}'re through to the Founding Operator group.\n\n` +
    `Your reference is ${opts.reference} — keep it, and quote it if you ever write to us.\n\n` +
    `Set your desk up here: ${link}\n\n` +
    `It takes a few minutes: your business details, then a code to your email, and the desk is yours. ` +
    `Reply to this email if anything is in your way.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${who}'re through to the Founding Operator group.</div>` +
    `<div style="margin:20px 0;padding:14px 16px;background:#f4f3f0;border-radius:12px">` +
    `<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a">Your reference</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:22px;font-weight:700;letter-spacing:.12em;margin-top:4px">${opts.reference}</div></div>` +
    `<a href="${link}" style="display:block;text-align:center;padding:14px;background:#1D6B45;color:#fff;border-radius:12px;font-weight:700;text-decoration:none;font-size:14px">Set up your desk</a>` +
    `<div style="font-size:13px;color:#8a8a8a;margin-top:16px;line-height:1.6">A few minutes: your business details, then a code to your email. Reply to this if anything is in your way.</div>` +
    `</div>`;
  return { subject, text, html };
}

/* Support reset somebody's password. They get a temporary one and have to
   pick their own before the desk opens. */
export function tempPasswordEmail(o: { name: string; tempPassword: string; signInId: string }): { subject: string; text: string; html: string } {
  const subject = "Your CurrencyDesk password was reset";
  const text =
    `${o.name}, we reset your password at your request.\n\n` +
    `Sign in as ${o.signInId} with this temporary password: ${o.tempPassword}\n\n` +
    `You will be asked to pick your own straight away, and every device that was signed in has been signed out. ` +
    `If you did not ask for this, reply to this email now.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${o.name}, we reset your password. Sign in as <b style="color:#0a0a0a">${o.signInId}</b> with this temporary password:</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:26px;font-weight:700;letter-spacing:.12em;margin:20px 0;padding:16px 0;text-align:center;background:#f4f3f0;border-radius:12px">${o.tempPassword}</div>` +
    `<div style="font-size:13px;color:#8a8a8a;line-height:1.6">You will pick your own straight away. Every signed-in device has been signed out. If you did not ask for this, reply now.</div>` +
    `</div>`;
  return { subject, text, html };
}

/* Their CurrencyDesk ID — issued, or replaced because the old one got about. */
export function cdIdEmail(o: { name: string; cdId: string; replaced: boolean }): { subject: string; text: string; html: string } {
  const subject = o.replaced ? "Your new CurrencyDesk ID" : "Your CurrencyDesk ID";
  const text =
    `${o.name}, your CurrencyDesk ID is ${o.cdId}.\n\n` +
    `Sign in with it, and quote it whenever you write to us.` +
    (o.replaced ? `\n\nThis replaces your previous ID, which no longer works.` : "");
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${o.name}, this is your CurrencyDesk ID. Sign in with it, and quote it whenever you write to us.</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:28px;font-weight:700;letter-spacing:.14em;margin:20px 0;padding:16px 0;text-align:center;background:#f4f3f0;border-radius:12px">${o.cdId}</div>` +
    (o.replaced ? `<div style="font-size:13px;color:#8a8a8a">This replaces your previous ID, which no longer works.</div>` : "") +
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
