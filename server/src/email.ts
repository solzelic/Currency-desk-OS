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
import { applicationReceived, codeEmail, contactReceivedEmail, passwordResetEmail, youreIn } from "./emails/design.js";

export { contactReceivedEmail, passwordResetEmail };

export type EmailStatus = "sent" | "simulated" | "failed";

/* Where a reply lands.

   Most of what we send is a code or a link and wants no answer. A reply
   written by a person in the panel is the opposite: the whole point is
   that they can write back, and a conversation that dead-ends at
   noreply@ is not one. Set REPLY_TO to an inbox somebody reads. */
export const replyToAddress = (): string | undefined =>
  process.env.REPLY_TO?.trim() || undefined;

export async function sendEmail(
  to: string,
  subject: string,
  body: { text: string; html?: string; replyTo?: string },
): Promise<EmailStatus> {
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
      body: JSON.stringify({
        from, to, subject, text: body.text, html: body.html,
        ...(body.replyTo ? { reply_to: body.replyTo } : {}),
      }),
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

/* A3 — the sign-in code. A returning owner proving it's them.

   After the invitation this is the email a customer sees most often: one on
   every single sign-in, forever. It was the last one still rendering the
   plain fallback while everything around it had been redrawn — the least
   designed email in the product was also the most seen.

   It renders through the same `codeEmail` the password-reset email already
   uses, so the two emails a person receives when they are having trouble
   getting in now look like they came from the same company. */
export function loginCodeEmail(code: string, name?: string): { subject: string; text: string; html: string } {
  return codeEmail({
    name,
    subject: `${code} is your CurrencyDesk sign-in code`,
    preheader: `Your sign-in code is ${code}. It expires in 10 minutes.`,
    heading: "Your sign-in code",
    lead: "enter this to finish signing in.",
    code,
    /* Says what to do if it wasn't them. A code arriving unprompted means
       somebody has the password — which is the actual news in this email,
       and worth more than the expiry. */
    under: "Expires in 10 minutes. If you didn't just try to sign in, somebody may have your password — change it as soon as you're in.",
    footer: "Sent because someone signed in to CurrencyDesk with your address.",
  });
}

/* The invitation. What an accepted applicant gets when an operator moves
   them to "invited": their reference, and the one link that starts the desk.
   Deliberately short — the next thing they should do is create it. */
/* Somebody has picked their application up. Sent the moment they move into
   review, because the gap between "we got it" and "you're in" is where an
   applicant decides we are not serious — and it costs nothing to say so. */
export interface ReviewOpts {
  name?: string | null;
  /* What the shop is called. Collected on the application; falls back to
     the workspace they chose, because the design's whole first line is
     "thanks for putting <their shop> forward" and a blank there reads
     like a mail merge that failed. */
  shopName?: string | null;
  reference?: string;
  place?: string | null;
}
export function reviewEmail(o: ReviewOpts): { subject: string; text: string; html: string } {
  return applicationReceived({ name: o.name, shopName: o.shopName, reference: o.reference ?? "", place: o.place });
}

export interface InviteOpts {
  name?: string | null;
  shopName?: string | null;
  reference: string;
  origin: string;
  /* Their place in the founding hundred, printed on the card. */
  cohortNo?: number | null;
  place?: string | null;
  issuedOn?: Date;
}
export function inviteEmail(o: InviteOpts): { subject: string; text: string; html: string } {
  /* Straight into setup, with their code already in the link so most people
     never type it. NOT /signup — that is the application they have already
     filled in, and sending an accepted operator back to it is the one thing
     this email must not do. */
  const setupUrl = `${o.origin}/onboarding/${encodeURIComponent(o.reference)}`;
  return youreIn({
    name: o.name, shopName: o.shopName, reference: o.reference, setupUrl,
    cohortNo: o.cohortNo, place: o.place, issuedOn: o.issuedOn,
  });
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

/* A person writing back.

   Deliberately plain. Everything else we send is a transactional notice
   with a code in a box; this is one human answering another, so it looks
   like an email somebody typed — their words, our name under it, and
   nothing else competing for attention. The subject carries the
   reference so a thread stays a thread in their client. */
/* Anything else.

   The written emails cover the moments we already know about. This is the
   rest of business — a question after a call, a heads-up before a
   deployment, an apology. Same letterhead, same signature, same promise
   that a reply reaches a person; the operator supplies the subject as
   well as the words, and nothing is prefilled but their name.

   It exists so that "I'll just use my own mail client" stops being the
   answer. Mail sent from somebody's laptop is off the record, in the
   wrong voice, and invisible to whoever picks the customer up next. */
export function customEmail(o: { name?: string | null; subject: string; body: string; from: string }):
  { subject: string; text: string; html: string } {
  return letter({ name: o.name, subject: o.subject.trim(), body: o.body, from: o.from });
}

export function replyEmail(o: { name?: string | null; body: string; reference: string; from: string }):
  { subject: string; text: string; html: string } {
  return letter({ name: o.name, subject: `Re: your note to CurrencyDesk (${o.reference})`, body: o.body, from: o.from });
}

/* One person writing to another, on our paper. Shared so a reply and a
   letter you composed cannot end up looking like they came from two
   different companies. */
function letter(o: { name?: string | null; subject: string; body: string; from: string }):
  { subject: string; text: string; html: string } {
  const hi = o.name ? `${o.name.trim().split(/\s+/)[0]},` : "Hello,";
  const subject = o.subject;
  const text = `${hi}\n\n${o.body}\n\n\u2014 ${o.from}\nCurrencyDesk\n\nJust reply to this email if there is more.`;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:15px;line-height:1.65;color:#0a0a0a">${esc(hi)}</div>` +
    `<div style="font-size:15px;line-height:1.65;color:#444;margin-top:14px;white-space:pre-wrap">${esc(o.body)}</div>` +
    `<div style="font-size:15px;line-height:1.65;color:#444;margin-top:18px">\u2014 ${esc(o.from)}<br>CurrencyDesk</div>` +
    `<div style="font-size:13px;color:#8a8a8a;margin-top:22px;border-top:1px solid #e8e4da;padding-top:12px">Just reply to this email if there is more.</div>` +
    `</div>`;
  return { subject, text, html };
}
