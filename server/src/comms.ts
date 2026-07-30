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
  sample: () => { subject: string; text: string; html: string };
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
    sample: () => reviewEmail({ name: "Amir Rostami" }),
  },
  {
    id: "invite",
    title: "You're in — set up your desk",
    audience: "applicant",
    when: "When you approve an application. Carries their reference and the setup link.",
    automatic: false,
    stage: "invited",
    sample: () => inviteEmail({ name: "Amir Rostami", reference: "CD-7BETHC", origin: SAMPLE_ORIGIN }),
  },
  {
    id: "signup_code",
    title: "Your verification code",
    audience: "operator",
    when: "During setup, when they ask us to confirm their email address.",
    automatic: true,
    sample: () => verificationEmail("418206", "York Currency Exchange"),
  },
  {
    id: "login_code",
    title: "Your sign-in code",
    audience: "staff",
    when: "On sign-in, when the desk requires a code as well as a password.",
    automatic: true,
    sample: () => loginCodeEmail("418206", "Amir Rostami"),
  },
  {
    id: "cd_id",
    title: "Your CurrencyDesk ID",
    audience: "staff",
    when: "When you issue somebody an ID, or replace one that got about.",
    automatic: false,
    sample: () => cdIdEmail({ name: "Amir Rostami", cdId: "CD-4417-9082", replaced: false }),
  },
  {
    id: "temp_password",
    title: "Your password was reset",
    audience: "staff",
    when: "When you reset somebody's password for them.",
    automatic: false,
    sample: () => tempPasswordEmail({ name: "Amir Rostami", tempPassword: "quiet-harbour-71", signInId: "a.rostami" }),
  },
  {
    id: "reply",
    title: "A reply to their message",
    audience: "applicant",
    when: "When you write back from the Inbox. Whatever you typed, sent as an ordinary email.",
    automatic: false,
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
    sample: () => ({
      subject: "Early access application · CD-7BETHC",
      text: "Early access application — CD-7BETHC\n\nFrom:  Amir Rostami <amir@yorkville.example>\njurisdiction:  CA\nmonthlyVolume:  Under $500K",
      html: "",
    }),
  },
];

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
