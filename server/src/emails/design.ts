/* ============================================================
   The designed emails, as email.

   WHY THIS IS NOT A COPY-PASTE OF THE DESIGN

   `design/emails/CurrencyDesk Emails.dc.html` is a web page. It lays
   things out with flexbox, animates the charter card, and reads its
   colours from CSS custom properties. None of that survives the trip:
   Gmail strips most of it, Outlook on Windows renders through Word and
   understands neither flex nor custom properties, and an animation is
   simply gone. So every screen is rebuilt here as nested tables with
   inline styles, keeping the design's typography, spacing and colour and
   dropping only what no mail client can show.

   WHAT IS DELIBERATELY MISSING, AND WHY

   The design draws two things we cannot honestly send yet.

   The FOUNDING CODE box — "enter it at the payment step and the first
   three months come to zero" — describes a promo code that does not
   exist against a checkout that does not exist. Setup does not currently
   end at a payment step at all, so nobody is charged anything; printing
   a code that works nowhere is the exact failure this codebase keeps
   refusing elsewhere.

   The SAVE YOUR CARD link needs the charter card rendered server-side to
   a PNG. It is drawn in the browser at the end of setup today, so there
   is no URL to point at. The card itself is here — it is the middle of
   the email — just not a download of it.

   Both are noted in docs/EMAIL-BUILD.md. Everything else is the design.

   ONE HONEST RELABELLING

   The design's card reads "CurrencyDesk ID · Sign-in". At the moment
   this email is sent there is no account and no ID: what they hold is a
   reference that opens their setup, and it stops working if we take the
   invitation back. Calling it a sign-in would be a lie in beautiful
   type, so the card says what the thing actually is.
   ============================================================ */

const SERIF = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const SANS = "'Schibsted Grotesk', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'IBM Plex Mono', 'SFMono-Regular', Consolas, Courier, monospace";

/* The design's light palette, resolved. Custom properties do not reach
   Outlook, so the fallbacks the design carries are simply the values. */
const BG = "#E7E3DA";
const CARD = "#FBF9F4";
const INK = "#17140F";
const MUTE = "#5C554C";
const FAINT = "#9A938A";
const LINE = "#dcd7cc";
const HAIR = "#e6e1d7";
const SOFT = "#f1ede4";
const GREEN = "#1D6B45";
const DEEP = "#0B1710";
const BRASS = "#A9791C";

export const esc = (s: string): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The wordmark. A flex lockup in the design; a two-cell table here,
   because that is the only way two things sit side by side everywhere. */
const wordmark = (ink: string, os: string, size: number) =>
  `<span style="font-family:${SANS};font-size:${size}px;font-weight:800;letter-spacing:0.05em;color:${ink}">CURRENCYDESK</span>` +
  `<span style="font-family:${MONO};font-size:${(size * 0.52).toFixed(1)}px;font-weight:600;letter-spacing:0.1em;color:${os}">&nbsp;OS</span>`;

/* Two things on one line, one left one right. The design uses flex for
   this in five places; every one of them becomes this. */
const split = (left: string, right: string, marginTop = 0) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse${marginTop ? `;margin-top:${marginTop}px` : ""}"><tr>` +
  /* The gap is padding on the left cell rather than empty space between
     them: inside the reference plate the table shrinks to its contents,
     and without it the two little labels sit shoulder to shoulder. */
  `<td align="left" style="text-align:left;padding-right:22px">${left}</td>` +
  `<td align="right" style="text-align:right">${right}</td>` +
  `</tr></table>`;

const rule = (color: string, marginTop: number) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:${marginTop}px"><tr>` +
  `<td style="height:1px;line-height:1px;font-size:0;background-color:${color}">&nbsp;</td></tr></table>`;

/* The page around every email: the wordmark, the card, the footer line.
   `preheader` is the grey sentence a mail client shows beside the subject
   in the list — it is not optional, because without one the client picks
   the first words of the body and shows those instead. */
function shell(opts: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title></title></head>` +
    `<body style="margin:0;padding:0;background-color:${BG}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${esc(opts.preheader)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background-color:${BG}"><tr>` +
    `<td align="center" style="padding:26px 12px 34px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse">` +
    `<tr><td align="center" style="padding:0 0 16px;text-align:center">${wordmark(INK, GREEN, 12.5)}</td></tr>` +
    `<tr><td style="background-color:${CARD};border:1px solid ${LINE};border-radius:16px;padding:0">${opts.body}</td></tr>` +
    `<tr><td align="center" style="padding:14px 24px 0;text-align:center">` +
    `<span style="font-family:${MONO};font-size:10px;line-height:1.6;color:${FAINT}">${opts.footer}</span>` +
    `</td></tr></table></td></tr></table></body></html>`;
}

const signoff =
  `<p style="font-family:${SERIF};font-style:italic;font-size:19px;color:${INK};margin:24px 0 0">&mdash; SAM</p>` +
  `<div style="font-family:${MONO};font-size:10px;line-height:1.6;color:${FAINT};margin-top:5px">` +
  `Smart Automated Machine &middot; CurrencyDesk<br>SAM writes and calls. A person reads every reply.</div>`;

const firstName = (n?: string | null): string => {
  const t = String(n ?? "").trim();
  if (!t) return "";
  /* Applications arrive with whatever was typed into a name box, which is
     sometimes a phone number or a shop. Greeting somebody as "445454"
     reads worse than not greeting them at all. */
  if (!/[A-Za-z]/.test(t)) return "";
  return t.split(/\s+/)[0]!;
};

export interface A1 { name?: string | null; shopName?: string | null; reference: string; place?: string | null }

/* A1 · Application received. Fires the moment an application lands. */
export function applicationReceived(o: A1): { subject: string; text: string; html: string } {
  const first = firstName(o.name);
  const shop = String(o.shopName ?? "").trim();
  const subject = "We're looking at your shop";
  const preheader = "A call today. Nothing for you to do before then.";

  const thanks = first && shop ? `${first} — thanks for putting ${shop} forward.`
    : first ? `${first} — thanks for putting your shop forward.`
    : shop ? `Thanks for putting ${shop} forward.`
    : "Thanks for putting your shop forward.";

  const text =
    `We're looking at your shop.\n\n${thanks}\n\n` +
    `Over the next few minutes we'll look at your shop the way one of your customers would — your website, your rates, how easy you are to find. It means that when we speak, we're not asking you questions we could have answered ourselves.\n\n` +
    `WHAT HAPPENS TODAY\nA call — about ten minutes, mostly us listening.\nIf it's a fit, your reference and setup link land while we're still on the phone.\n\n` +
    `Nothing for you to do before then. If we ring at a bad moment, say so and we'll call back.\n\n` +
    `— SAM\nSmart Automated Machine · CurrencyDesk\nSAM writes and calls. A person reads every reply.\n\n` +
    `Reference ${o.reference}\nYou applied at currencydeskos.com. Reply to this email and a person reads it.`;

  const body =
    `<div style="padding:38px 40px 34px">` +
    `<div style="font-family:${SERIF};font-size:30px;line-height:1.1;letter-spacing:-0.015em;color:${INK}">We're looking at your shop.</div>` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:16px 0 0">${esc(thanks)}</p>` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:13px 0 0">Over the next few minutes we&rsquo;ll look at your shop the way one of your customers would &mdash; your website, your rates, how easy you are to find. It means that when we speak, we&rsquo;re not asking you questions we could have answered ourselves.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;margin-top:22px"><tr>` +
    `<td style="padding:16px 18px;border-radius:12px;background-color:${SOFT};border:1px solid ${HAIR}">` +
    `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${FAINT};font-weight:600">What happens today</div>` +
    `<div style="font-family:${SANS};font-size:14px;line-height:1.7;color:${INK};margin-top:8px">A call &mdash; about ten minutes, mostly us listening.<br>If it&rsquo;s a fit, your reference and setup link land while we&rsquo;re still on the phone.</div>` +
    `</td></tr></table>` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:20px 0 0">Nothing for you to do before then. If we ring at a bad moment, say so and we&rsquo;ll call back.</p>` +
    signoff +
    `<div style="margin-top:26px;padding-top:16px;border-top:1px solid ${HAIR}">` +
    split(
      `<span style="font-family:${MONO};font-size:10px;color:${FAINT}">Reference ${esc(o.reference)}</span>`,
      o.place ? `<span style="font-family:${MONO};font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:${FAINT}">${esc(o.place)}</span>` : "",
    ) +
    `</div></div>`;

  return {
    subject, text,
    html: shell({ preheader, body, footer: "You applied at currencydeskos.com. Reply to this email and a person reads it." }),
  };
}

export interface A2 {
  name?: string | null;
  shopName?: string | null;
  reference: string;
  setupUrl: string;
  cohortNo?: number | null;
  place?: string | null;
  issuedOn?: Date;
}

const ISSUED = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")} ${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/* A2 · You're in. Sent when an application is approved — on the call. */
export function youreIn(o: A2): { subject: string; text: string; html: string } {
  const first = firstName(o.name);
  const shop = String(o.shopName ?? "").trim();
  const issued = ISSUED(o.issuedOn ?? new Date());
  const subject = "Your CurrencyDesk reference is inside";
  const preheader = "Three months, the whole system, no card.";

  const head = first ? `You're in, ${first}.` : "You're in.";
  const sub = shop ? `We looked at ${shop} and we'd like you on the desk.` : "We looked at your shop and we'd like you on the desk.";
  const cohort = o.cohortNo ? `Nº ${String(o.cohortNo).padStart(3, "0")} of 100` : "Founding cohort";
  const holder = [String(o.name ?? "").trim().toUpperCase(), String(o.place ?? "").trim().toUpperCase()].filter(Boolean).join(" · ");

  const text =
    `${head}\n\n${sub}\n\n` +
    `YOUR REFERENCE — OPENS YOUR SETUP\n${o.reference}\n${cohort} · issued ${issued}\n\n` +
    `Hold on to it. It opens your setup, and it is what to quote whenever you write to us.\n\n` +
    `SET UP YOUR DESK\n${o.setupUrl}\nTakes about ten minutes.\n\n` +
    `THREE THINGS WORTH KNOWING\n\n` +
    `Three months, free, all of it.\nNot a trial tier — the whole system, every application. Nothing is charged, and we'll tell you before anything ever is.\n\n` +
    `We're going to ask you a lot.\nThat's the trade. You're one of the first hundred desks, and what we want back is your opinion — what's slow, what's wrong, what you'd never use. We'd rather hear it early and rudely than politely in six months.\n\n` +
    `A phone call in a week.\nA proper follow-up, once you've had the desk in your hands a few days — and a person, not SAM. Not a sales call. Nothing to book; we'll use this number.\n\n` +
    `One thing free doesn't cover: client verification is run by a third-party provider and billed per file. Prices vary by provider and region, and the desk always shows you the cost before it runs one.\n\n` +
    `— SAM\nSmart Automated Machine · CurrencyDesk\nSAM writes and calls. A person reads every reply.\n\n` +
    `Your founding rate is held for the life of the account. Reply to this email and a person reads it.`;

  /* The charter card. In the design it floats and catches a sheen; both
     are animations, so both are gone. What is left is the object: green
     card, cohort number, their name in the plate. */
  const card =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${GREEN}" style="width:100%;border-collapse:separate;border-radius:14px;background-color:${GREEN}"><tr>` +
    `<td style="padding:22px 24px 20px">` +
    split(wordmark("#ffffff", "#7fe3ab", 10), `<span style="font-family:${MONO};font-size:8.5px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(255,255,255,0.62)">${esc(cohort)}</span>`) +
    rule("rgba(255,255,255,0.2)", 16) +
    `<div style="font-family:${MONO};font-size:8.5px;letter-spacing:0.18em;text-transform:uppercase;color:#b7f0d0;font-weight:600;margin-top:18px">Founding Operator</div>` +
    (shop ? `<div style="font-family:${SERIF};font-size:27px;line-height:1.06;letter-spacing:-0.012em;color:#ffffff;margin-top:5px">${esc(shop)}</div>` : "") +
    /* The plate. Labelled for what it is: the thing that opens their
       setup, not a sign-in they do not have yet. */
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${DEEP}" style="margin-top:16px;border-collapse:separate;border-radius:7px;background-color:${DEEP}"><tr>` +
    `<td style="padding:12px 17px 13px">` +
    split(
      `<span style="font-family:${MONO};font-size:7px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.5);font-weight:600">Your reference</span>`,
      `<span style="font-family:${MONO};font-size:7px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.4);font-weight:600">Opens your setup</span>`,
    ) +
    `<div style="font-family:${SANS};font-size:27px;font-weight:800;letter-spacing:0.09em;color:#ffffff;margin-top:6px">${esc(o.reference)}</div>` +
    `</td></tr></table>` +
    rule("rgba(255,255,255,0.14)", 18) +
    split(
      holder ? `<span style="font-family:${MONO};font-size:9px;letter-spacing:0.1em;color:rgba(255,255,255,0.72)">${esc(holder)}</span>` : "",
      `<span style="font-family:${MONO};font-size:9px;letter-spacing:0.1em;color:rgba(255,255,255,0.72)">ISSUED ${issued}</span>`,
      11,
    ) +
    `</td></tr></table>`;

  const point = (title: string, said: string) =>
    `<div style="margin-top:16px">` +
    `<div style="font-family:${SANS};font-size:15px;font-weight:700;color:${INK}">${title}</div>` +
    `<div style="font-family:${SANS};font-size:14px;line-height:1.6;color:${MUTE};margin-top:4px">${said}</div></div>`;

  const body =
    `<div style="padding:34px 34px 0">` +
    `<div style="font-family:${SERIF};font-size:32px;line-height:1.06;letter-spacing:-0.02em;color:${INK};text-align:center">${esc(head)}</div>` +
    `<div style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${MUTE};margin-top:9px;text-align:center">${esc(sub)}</div>` +
    `</div>` +
    `<div style="padding:24px 34px 0">${card}</div>` +
    `<div style="padding:26px 34px 34px">` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:0">Hold on to that reference. It opens your setup, and it is what to quote whenever you write to us.</p>` +
    /* The button. bgcolor on the cell as well as the style, because Word
       ignores the one and honours the other. */
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;margin-top:26px"><tr>` +
    `<td align="center" bgcolor="${BRASS}" style="border-radius:13px;background-color:${BRASS}">` +
    `<a href="${esc(o.setupUrl)}" style="display:block;padding:20px 30px;font-family:${MONO};font-size:13.5px;letter-spacing:0.16em;text-transform:uppercase;font-weight:700;color:#ffffff;text-decoration:none;text-align:center">Set up your desk &rarr;</a>` +
    `</td></tr></table>` +
    `<div style="font-family:${MONO};font-size:10.5px;color:${FAINT};margin-top:11px;text-align:center">Takes about ten minutes</div>` +
    `<div style="margin:28px 0 0;padding-top:24px;border-top:1px solid ${HAIR}">` +
    `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:${BRASS};font-weight:600">Three things worth knowing</div>` +
    point("Three months, free, all of it.",
      "Not a trial tier &mdash; the whole system, every application. Nothing is charged, and we&rsquo;ll tell you before anything ever is.") +
    point("We&rsquo;re going to ask you a lot.",
      "That&rsquo;s the trade. You&rsquo;re one of the first hundred desks, and what we want back is your opinion &mdash; what&rsquo;s slow, what&rsquo;s wrong, what you&rsquo;d never use. We&rsquo;d rather hear it early and rudely than politely in six months.") +
    point("A phone call in a week.",
      "A proper follow-up, once you&rsquo;ve had the desk in your hands a few days &mdash; and a person, not SAM. Not a sales call. We want to hear what&rsquo;s slow and what&rsquo;s wrong. Nothing to book; we&rsquo;ll use this number.") +
    `</div>` +
    `<p style="font-family:${SANS};font-size:13.5px;line-height:1.6;color:${MUTE};margin:20px 0 0">One thing free doesn&rsquo;t cover: client verification is run by a third-party provider and billed per file. Prices vary by provider and region, and the desk always shows you the cost before it runs one.</p>` +
    signoff +
    `</div>`;

  return {
    subject, text,
    html: shell({ preheader, body, footer: "Your founding rate is held for the life of the account. Reply to this email and a person reads it." }),
  };
}


/* A code, in a box, on our paper.

   Shared by the two emails whose whole content is six digits: the reset
   code and the contact acknowledgement's reference. The design draws these
   the same way each time — big mono type on a soft panel — so they are
   drawn here once rather than diverging by hand. */
export function codeEmail(o: {
  name?: string | null;
  subject: string;
  preheader: string;
  heading: string;
  lead: string;
  code: string;
  under: string;
  footer: string;
}): { subject: string; text: string; html: string } {
  const first = firstName(o.name);
  const hi = first ? `${first}, ` : "";
  const text =
    `${o.heading}\n\n${hi}${o.lead}\n\n${o.code}\n\n${o.under}\n\n` +
    `— SAM\nSmart Automated Machine · CurrencyDesk\nSAM writes and calls. A person reads every reply.\n\n${o.footer}`;
  const body =
    `<div style="padding:38px 40px 34px">` +
    `<div style="font-family:${SERIF};font-size:30px;line-height:1.1;letter-spacing:-0.015em;color:${INK}">${esc(o.heading)}</div>` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:16px 0 0">${esc(hi + o.lead)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;margin-top:22px"><tr>` +
    `<td align="center" style="padding:20px 18px;border-radius:12px;background-color:${SOFT};border:1px solid ${HAIR};text-align:center">` +
    `<div style="font-family:${MONO};font-size:32px;font-weight:700;letter-spacing:0.24em;color:${INK}">${esc(o.code)}</div>` +
    `</td></tr></table>` +
    `<p style="font-family:${SANS};font-size:13.5px;line-height:1.6;color:${MUTE};margin:16px 0 0">${esc(o.under)}</p>` +
    signoff +
    `</div>`;
  return { subject: o.subject, text, html: shell({ preheader: o.preheader, body, footer: o.footer }) };
}

/* Somebody could not get in.

   The one email that has to be careful about what it says to a person who
   did NOT ask for it: it names no shop, confirms no account, and tells
   them plainly that ignoring it leaves everything as it was. */
export function passwordResetEmail(code: string, name?: string | null, minutes = 15):
  { subject: string; text: string; html: string } {
  return codeEmail({
    name,
    subject: `${code} — your CurrencyDesk reset code`,
    preheader: `Good for ${minutes} minutes. If this was not you, nothing has changed.`,
    heading: "Let's get you back in.",
    lead: "use this code to set a new password. It is the only thing you need — no old password, no phone call.",
    code,
    under:
      `It is good for ${minutes} minutes and works once. Setting a new password signs out every device, ` +
      `so you will sign in again with the new one.\n\nIf you did not ask for this, ignore it — nothing has changed, ` +
      `and nobody can use this code without your inbox.`,
    footer: "Reply to this email and a person reads it.",
  });
}

/* A4 · somebody wrote to us from the contact page.

   Before this they heard nothing at all until a person got to it, which on
   a weekend is two days of silence after being told we would reply. It
   quotes their reference so the thread has a name, and repeats what they
   sent so they can see it arrived intact. */
export function contactReceivedEmail(o: {
  name?: string | null;
  reference: string;
  topic?: string | null;
  message?: string | null;
}): { subject: string; text: string; html: string } {
  const first = firstName(o.name);
  const subject = `Got it — ${o.reference}`;
  const preheader = "A person reads every one of these. You will hear back within a business day.";
  const said = String(o.message ?? "").trim();
  const topic = String(o.topic ?? "").trim();

  const text =
    `Got it.\n\n${first ? first + ", we" : "We"}'ve got your note and it is with a person, not a queue. ` +
    `You will hear back within a business day — usually the same one.\n\n` +
    `YOUR REFERENCE\n${o.reference}\n\n` +
    (topic ? `About: ${topic}\n` : "") +
    (said ? `\nWhat you sent us:\n${said}\n` : "") +
    `\nIf anything changes in the meantime, just reply to this email — it lands on the same thread.\n\n` +
    `— SAM\nSmart Automated Machine · CurrencyDesk\nSAM writes and calls. A person reads every reply.\n\n` +
    `You wrote to us at currencydeskos.com.`;

  const body =
    `<div style="padding:38px 40px 34px">` +
    `<div style="font-family:${SERIF};font-size:30px;line-height:1.1;letter-spacing:-0.015em;color:${INK}">Got it.</div>` +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:16px 0 0">` +
    `${first ? esc(first) + ", we" : "We"}&rsquo;ve got your note and it is with a person, not a queue. ` +
    `You will hear back within a business day &mdash; usually the same one.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:separate;margin-top:22px"><tr>` +
    `<td style="padding:16px 18px;border-radius:12px;background-color:${SOFT};border:1px solid ${HAIR}">` +
    `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${FAINT};font-weight:600">Your reference</div>` +
    `<div style="font-family:${MONO};font-size:20px;font-weight:700;letter-spacing:0.1em;color:${INK};margin-top:6px">${esc(o.reference)}</div>` +
    (topic ? `<div style="font-family:${SANS};font-size:13px;color:${MUTE};margin-top:10px">About: ${esc(topic)}</div>` : "") +
    `</td></tr></table>` +
    (said
      ? `<div style="font-family:${MONO};font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${FAINT};font-weight:600;margin-top:22px">What you sent us</div>` +
        `<p style="font-family:${SANS};font-size:14px;line-height:1.65;color:${MUTE};margin:8px 0 0;white-space:pre-wrap">${esc(said)}</p>`
      : "") +
    `<p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${MUTE};margin:20px 0 0">If anything changes in the meantime, just reply to this email &mdash; it lands on the same thread.</p>` +
    signoff +
    `</div>`;

  return { subject, text, html: shell({ preheader, body, footer: "You wrote to us at currencydeskos.com." }) };
}
