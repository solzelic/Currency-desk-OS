/* ============================================================
   Everything CurrencyDesk says to anybody, in one list.

   WHY THIS EXISTS

   The emails were written and they work, but there was no way to answer
   the questions an operator actually asks: what do we send? when does it
   go? did it go, or was it simulated because nobody set the API key? Who
   sends it — us, or does it happen on its own?

   Until you can answer those, "coordinating the emails" means reading
   source. And an automated reviewer — the agent that will eventually
   work the queue — needs the same list for the same reason: it has to
   know which of its moves speak to a customer before it makes them.

   WHAT THIS IS NOT

   It is not the sender. `sendEmail` stays where it is, and each stage
   still declares its own mail beside the stage in pipeline.ts. This is
   the catalogue that points at them, so there is one page that lists
   what leaves the building.
   ============================================================ */
import {
  cdIdEmail, inviteEmail, loginCodeEmail, replyEmail, reviewEmail,
  tempPasswordEmail, verificationEmail,
} from "./email.js";

/* Who is on the other end. Worth naming, because "an email went out" is a
   very different fact depending on whether it reached a customer, one of
   their staff, or us. */
export type Audience = "applicant" | "operator" | "staff" | "platform";

export interface Rendered { subject: string; text: string; html: string }

/* The person a hand-sent email is going to, as the panel knows them.
   Everything here comes off the enquiry record — nothing is typed. */
export interface Recipient {
  name: string | null;
  email: string;
  reference: string;
  status: string;
  kind: string;
}

/* Something the operator has to supply because the template cannot know
   it. Kept to a minimum on purpose: every field is a chance to send
   somebody the wrong thing. */
export interface Field {
  id: string;
  label: string;
  help: string;
  /* more than one line renders a textarea rather than an input */
  lines?: number;
  placeholder?: string;
}

/* What it takes to send this one by hand, from a person's page. */
export interface Manual {
  /* The button, in the operator's words. */
  action: string;
  needs: Field[];
  /* Why it cannot go to THIS person right now — null when it can. Guards
     live here rather than in the route so the list the panel draws and
     the check the send performs are the same code, and a greyed-out
     button can never disagree with a 409. */
  blocked?: (to: Recipient) => string | null;
  render: (to: Recipient, fields: Record<string, string>, ctx: { origin: string; from: string }) => Rendered;
}

export interface Dispatch {
  id: string;
  title: string;
  audience: Audience;
  /* In plain English, because this is read by somebody deciding whether a
     click is safe, not by a compiler. */
  when: string;
  /* Does it go on its own, or does a person cause it? The difference is
     the whole point of the list: the automatic ones are the ones that can
     surprise you. */
  automatic: boolean;
  /* The pipeline stage whose arrival sends it, where that is what fires
     it. Cross-checked against pipeline.ts by a test, so a stage cannot
     start or stop sending without this list noticing. */
  stage?: string;
  /* Present when an operator can pick this off a list and send it now.

     ABSENT IS ALSO A DECISION. Four of these carry a live credential — a
     sign-in code, a verification code, a CurrencyDesk ID, a temporary
     password. Their content has to be the real one, minted by the thing
     it belongs to, so there is no honest way to render them from a box
     somebody typed into: the mail would look perfect and the code inside
     it would not work. Those already have their own buttons, on the page
     that holds the credential, and `elsewhere` says where. */
  manual?: Manual;
  elsewhere?: string;
  sample: () => Rendered;
}

const SAMPLE_ORIGIN = "https://www.currencydeskos.com";

export const DISPATCHES: Dispatch[] = [
  {
    id: "review",
    title: "We're looking at your application",
    audience: "applicant",
    when: "The moment an application arrives. Nobody presses anything.",
    automatic: true,
    stage: "reviewing",
    manual: {
      action: "Send it again",
      needs: [],
      render: (to) => reviewEmail({ name: to.name }),
    },
    sample: () => reviewEmail({ name: "Amir Rostami" }),
  },
  {
    id: "invite",
    title: "You're in — set up your desk",
    audience: "applicant",
    when: "When you approve an application. Carries their reference and the setup link.",
    automatic: false,
    stage: "invited",
    manual: {
      action: "Send the invitation again",
      needs: [],
      /* The link in this email only opens while they are Invited, so
         sending it to anybody else hands them a dead door and a reason to
         ring up. Approving is what sends it the first time; this is for
         the one who deleted it. */
      blocked: (to) =>
        to.status === "invited"
          ? null
          : "This carries their setup link, and the link only opens while they are Invited. Approve them first — that sends this email on its own.",
      render: (to, _f, ctx) => inviteEmail({ name: to.name, reference: to.reference, origin: ctx.origin }),
    },
    sample: () => inviteEmail({ name: "Amir Rostami", reference: "CD-7BETHC", origin: SAMPLE_ORIGIN }),
  },
  {
    id: "signup_code",
    title: "Your verification code",
    audience: "operator",
    when: "During setup, when they ask us to confirm their email address.",
    automatic: true,
    elsewhere: "The code has to be the live one their setup screen is waiting for. They ask for it themselves on that screen, and pressing it again there is what re-sends it.",
    sample: () => verificationEmail("418206", "York Currency Exchange"),
  },
  {
    id: "login_code",
    title: "Your sign-in code",
    audience: "staff",
    when: "On sign-in, when the desk requires a code as well as a password.",
    automatic: true,
    elsewhere: "Only the sign-in they are part-way through can mint this code, and it dies in ten minutes. There is nothing useful to send from here.",
    sample: () => loginCodeEmail("418206", "Amir Rostami"),
  },
  {
    id: "cd_id",
    title: "Your CurrencyDesk ID",
    audience: "staff",
    when: "When you issue somebody an ID, or replace one that got about.",
    automatic: false,
    elsewhere: "An ID belongs to a person on a desk, not to an application. Open them under their desk and press “Issue an ID” — that mints the real one and emails it.",
    sample: () => cdIdEmail({ name: "Amir Rostami", cdId: "CD-4417-9082", replaced: false }),
  },
  {
    id: "temp_password",
    title: "Your password was reset",
    audience: "staff",
    when: "When you reset somebody's password for them.",
    automatic: false,
    elsewhere: "The password in it has to be one that actually works, so resetting is what sends it. Open them under their desk and press “Reset their password”.",
    sample: () => tempPasswordEmail({ name: "Amir Rostami", tempPassword: "quiet-harbour-71", signInId: "a.rostami" }),
  },
  {
    id: "reply",
    title: "A reply to their message",
    audience: "applicant",
    when: "When you write back from the Inbox. Whatever you typed, sent as an ordinary email.",
    automatic: false,
    manual: {
      action: "Send it",
      needs: [{
        id: "body",
        label: "What to say",
        help: "Their name goes on the top and yours on the bottom, so start with the answer. Plain words — no formatting survives the trip.",
        lines: 7,
        placeholder: "Yes — EUR cash settlement is supported, and there is nothing to switch on…",
      }],
      render: (to, f, ctx) => replyEmail({ name: to.name, body: f.body ?? "", reference: to.reference, from: ctx.from }),
    },
    sample: () => replyEmail({
      name: "Amir Rostami", reference: "CD-7BETHC", from: "Jordan",
      body: "Yes — EUR cash settlement is supported, and there is nothing to switch on. Happy to walk through how the float works on a call if that is useful.",
    }),
  },
  {
    id: "enquiry_alert",
    title: "New application / message",
    audience: "platform",
    when: "Every time the public site sends us something. Goes to the platform team, not the customer.",
    automatic: true,
    elsewhere: "This one comes to us, not to them. There is nobody to hand-send it to.",
    sample: () => ({
      subject: "Early access application · CD-7BETHC",
      text: "Early access application — CD-7BETHC\n\nFrom:  Amir Rostami <amir@yorkville.example>\njurisdiction:  CA\nmonthlyVolume:  Under $500K",
      html: "",
    }),
  },
];

export const DISPATCH = new Map(DISPATCHES.map((d) => [d.id, d]));

/* What can be sent to one particular person, right now.

   The panel draws its menu from this and the send route checks against
   this, so the greyed-out button and the refusal are never two different
   opinions. Everything is returned — including the ones that cannot go —
   because "why is that not in the list?" is a worse question to leave an
   operator holding than a disabled row with the reason next to it. */
export function sendableTo(to: Recipient): Array<{
  id: string; title: string; when: string; audience: Audience;
  action: string | null; needs: Field[]; blocked: string | null;
}> {
  return DISPATCHES.map((d) => ({
    id: d.id,
    title: d.title,
    when: d.when,
    audience: d.audience,
    action: d.manual?.action ?? null,
    needs: d.manual?.needs ?? [],
    blocked: d.manual ? d.manual.blocked?.(to) ?? null : d.elsewhere ?? "Not something to send by hand.",
  }));
}

/* Two deliberately separate stages that nothing else asked before.

   `hold` and `declined` send NOTHING, and that is a decision rather than
   an omission — so the panel says so out loud. Somebody looking at a
   held application should not be left wondering whether the applicant
   was told, and an agent should not "helpfully" add a message here. */
export const SILENT: { stage: string; why: string }[] = [
  { stage: "hold", why: "Holding somebody is a note to ourselves. Telling them they are parked is worse than saying nothing." },
  { stage: "declined", why: "A decline deserves a person writing to them, not an automated line." },
];

/* Whether any of this is actually leaving the building.

   `sendEmail` falls back to logging when the provider is not configured,
   which is exactly right for building and exactly wrong to discover on
   the day you send forty invitations. So the state is reported rather
   than hidden. */
export function delivery(): { live: boolean; from: string | null; detail: string; fix: string | null } {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || null;
  if (key && from) {
    return { live: true, from, detail: `Sending for real, from ${from}.`, fix: null };
  }
  const missing = [!key && "RESEND_API_KEY", !from && "EMAIL_FROM"].filter(Boolean).join(" and ");
  return {
    live: false,
    from,
    detail: "Simulated. Nothing reaches anybody — the text is written to the server log instead.",
    fix: `Set ${missing} to start sending.`,
  };
}
